import { spawn, ChildProcess } from "child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"
import type { DisplayEvent, TranscriptMapper } from "../display-protocol.js"

interface ProviderContext {
  userPrompt:   string
  systemPrompt: string
  options:      string[]
  cwd:          string
  model?:       string
  logFile:      string
  onChunk?:     (chunk: string) => void
  signal?:      AbortSignal
}

interface AgentResult {
  output: string
  choice: string
  transcriptPath?: string
  metadata?: Record<string, unknown>
}

// ─── Session sidecar ────────────────────────────────────────────────────────
// When the same node invokes the Claude provider more than once (typical for
// `persistent` nodes driven by an event loop), we want Claude to keep its
// conversation history instead of starting fresh each turn. We persist the
// first turn's session_id in a sidecar file next to the node's log, and
// switch to `--resume <id>` on every subsequent turn.

function sessionPathFor(logFile: string): string {
  return logFile.replace(/\.log$/, ".session")
}
function readExistingSession(logFile: string): string | null {
  const p = sessionPathFor(logFile)
  if (!existsSync(p)) return null
  const id = readFileSync(p, "utf8").trim()
  return id.length > 0 ? id : null
}
function writeSession(logFile: string, sessionId: string): void {
  writeFileSync(sessionPathFor(logFile), sessionId)
}

// ─── Child-process lifecycle ────────────────────────────────────────────────
// Track every live Claude subprocess so we can guarantee it's dead when the
// orchestrator exits. Without this, `cli.ts` calls `process.exit(0)` after a
// --quiet run completes, which abandons any still-running `claude` child to
// init — it keeps burning tokens until it finishes on its own.
//
// On abort (AbortSignal or parent exit) we SIGTERM first, then SIGKILL after
// a short grace period. `spawn` is called without `detached:true`/`unref()`
// so the child stays in our process group and `process.on("exit")` can reach
// it synchronously.

const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const killAll = () => {
    for (const p of liveChildren) { try { p.kill("SIGKILL") } catch {} }
  }
  // 'exit' is the only place we're guaranteed synchronous cleanup before
  // Node tears down. Signals arrive before exit, so handle them too — we
  // re-raise after cleanup so the default termination behavior still runs.
  process.on("exit", killAll)
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { killAll(); process.exit(128) })
  }
}

function trackChild(proc: ChildProcess): void {
  installExitHook()
  liveChildren.add(proc)
  proc.once("close", () => liveChildren.delete(proc))
}

function killWithEscalation(proc: ChildProcess): void {
  try { proc.kill("SIGTERM") } catch {}
  // If SIGTERM is ignored, escalate after 2s. Clear timer if the child exits
  // on its own so we don't leak a timer handle.
  const esc = setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, 2000)
  proc.once("close", () => clearTimeout(esc))
}

// ─── Blocking (non-streaming) execution ─────────────────────────────────────

function runBlocking(command: string, args: string[], cwd: string, logFile: string, signal?: AbortSignal): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    trackChild(proc)
    let out = "", err = ""
    const onAbort = () => killWithEscalation(proc)
    signal?.addEventListener("abort", onAbort, { once: true })
    proc.stdout!.on("data", (chunk: Buffer) => {
      const txt = chunk.toString(); out += txt
      appendFileSync(logFile, txt)
    })
    proc.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString() })
    proc.on("close", code => {
      signal?.removeEventListener("abort", onAbort)
      if (signal?.aborted) return rej(new Error(`Aborted: ${(signal as any).reason?.message ?? "signal"}`))
      code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err.slice(0, 300)}`))
    })
    proc.stdin!.end()
  })
}

// ─── Streaming (stream-json) execution ──────────────────────────────────────
// Parses NDJSON events, forwards text_delta to ctx.onChunk, captures the final
// "result" event. Also captures session_id for the sidecar.

interface StreamedResult {
  output:   string
  sessionId?: string
}

function runStreaming(
  command: string, args: string[], cwd: string, logFile: string,
  onChunk: (chunk: string) => void, signal?: AbortSignal,
): Promise<StreamedResult> {
  return new Promise((res, rej) => {
    const proc: ChildProcess = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    trackChild(proc)

    let buf = "", err = ""
    let accumulated = ""
    let finalResult: string | undefined
    let sessionId:   string | undefined

    const onAbort = () => killWithEscalation(proc)
    signal?.addEventListener("abort", onAbort, { once: true })

    const handleLine = (line: string) => {
      if (!line.trim()) return
      appendFileSync(logFile, line + "\n")
      let evt: any
      try { evt = JSON.parse(line) } catch { return }

      // Top-level session_id (on init and result events)
      if (typeof evt.session_id === "string") sessionId = evt.session_id

      // Anthropic-style stream_event wrapper with partial message deltas
      if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
        const delta = evt.event.delta
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          accumulated += delta.text
          try { onChunk(delta.text) } catch {}
          return
        }
      }

      // Assistant message blocks sometimes carry the final text
      if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block.type === "text" && typeof block.text === "string" && !accumulated.endsWith(block.text)) {
            // Don't double-count if streamed deltas already covered this text.
            // (The CLI may emit both deltas and the full assistant message.)
          }
        }
      }

      // Terminal result event — authoritative output
      if (evt.type === "result") {
        if (typeof evt.result === "string") finalResult = evt.result
      }
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ""
      for (const line of lines) handleLine(line)
    })
    proc.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString() })
    proc.on("close", code => {
      signal?.removeEventListener("abort", onAbort)
      if (buf.trim()) handleLine(buf)
      if (signal?.aborted) return rej(new Error(`Aborted: ${(signal as any).reason?.message ?? "signal"}`))
      if (code !== 0) return rej(new Error(`exit ${code}: ${err.slice(0, 400)}`))
      res({ output: finalResult ?? accumulated, sessionId })
    })
    proc.stdin?.end()
  })
}

// ─── Public entrypoint ──────────────────────────────────────────────────────

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const existingSession = readExistingSession(ctx.logFile)
  const sessionId       = existingSession ?? randomUUID()
  const streaming       = typeof ctx.onChunk === "function"

  // Dashboard meta sidecar
  const claudeProjects = `${process.env.HOME}/.claude/projects`
  const metaPath       = ctx.logFile.replace(/\.log$/, ".meta.json")
  writeFileSync(metaPath, JSON.stringify({
    transcriptFile: `${sessionId}.jsonl`, sessionId, claudeProjects, provider: "claude",
  }))

  // Argument assembly. Streaming mode drops --json-schema because stream-json
  // and schema validation don't compose; free-form output is fine for any
  // caller that opts into streaming (typically `persistent` nodes).
  const baseArgs: string[] = [
    "-p", ctx.userPrompt,
    "--system-prompt", ctx.systemPrompt,
    "--permission-mode", "auto",
    ...(existingSession ? ["--resume", existingSession] : ["--session-id", sessionId]),
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  let result: AgentResult
  if (streaming) {
    const args = [...baseArgs, "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    const streamed = await runStreaming("claude", args, ctx.cwd, ctx.logFile, ctx.onChunk!, ctx.signal)
    result = {
      output:   streamed.output,
      choice:   ctx.options[0] ?? "",
      metadata: { sessionId: streamed.sessionId ?? sessionId, streaming: true },
    }
    if (streamed.sessionId) writeSession(ctx.logFile, streamed.sessionId)
    else if (!existingSession) writeSession(ctx.logFile, sessionId)
  } else {
    // An empty options array would make the schema's choice.enum empty, which
    // the Claude CLI silently treats as "no schema" — the agent then returns
    // prose in `result` and no `structured_output`. For choice-less callers
    // (e.g. persistent nodes that strip options) skip the schema entirely and
    // take the raw result as free-form output.
    const hasOptions = ctx.options.length > 0
    const args = [...baseArgs, "--output-format", "json"]
    if (hasOptions) {
      const schema = JSON.stringify({
        type: "object",
        required: ["output", "choice"],
        properties: {
          output: { type: "string" },
          choice: { type: "string", enum: ctx.options },
        },
      })
      args.push("--json-schema", schema)
    }
    const raw = await runBlocking("claude", args, ctx.cwd, ctx.logFile, ctx.signal)
    const parsed = JSON.parse(raw.trim())
    if (hasOptions) {
      if (parsed.output !== undefined && parsed.choice !== undefined) result = parsed
      else if (parsed.structured_output?.output !== undefined && parsed.structured_output?.choice !== undefined) result = parsed.structured_output
      else if (parsed.result) result = JSON.parse(parsed.result)
      else throw new Error(`Unexpected Claude output shape: ${raw.slice(0, 200)}`)
    } else {
      result = { output: parsed.result ?? "", choice: "" }
    }
    result.metadata = { sessionId: parsed.session_id ?? sessionId, streaming: false }
    // Persist session for future turns
    if (!existingSession) writeSession(ctx.logFile, parsed.session_id ?? sessionId)
  }

  result.transcriptPath = `${sessionId}.jsonl`
  return result
}

export const mapTranscript: TranscriptMapper = (line: string) => {
  let parsed: any
  try { parsed = JSON.parse(line) } catch { return null }

  const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now()

  if (parsed.type === "queue-operation" || parsed.type === "attachment" || parsed.type === "system") return null

  if (parsed.type === "user" && Array.isArray(parsed.message?.content)) {
    const events: DisplayEvent[] = []
    for (const block of parsed.message.content) {
      if (block.type === "tool_result") {
        const result = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => b.text ?? "").join("").slice(0, 200)
            : "(result)"
        events.push({
          t: "tool_end",
          ts,
          id: block.tool_use_id ?? "",
          name: "",
          result: result.slice(0, 200),
        })
      }
    }
    return events.length > 0 ? events : null
  }

  if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
    const events: DisplayEvent[] = []
    for (const block of parsed.message.content) {
      if (block.type === "thinking" && block.thinking) {
        events.push({ t: "thinking", ts, text: block.thinking })
      }
      if (block.type === "text" && block.text) {
        events.push({
          t: "text",
          ts,
          text: block.text,
          final: parsed.message.stop_reason !== null,
        })
      }
      if (block.type === "tool_use") {
        const args: Record<string, string> = {}
        if (block.input) {
          for (const [k, v] of Object.entries(block.input)) {
            const s = typeof v === "string" ? v : JSON.stringify(v)
            args[k] = s.length > 100 ? s.slice(0, 100) + "..." : s
          }
        }
        events.push({
          t: "tool_start",
          ts,
          id: block.id ?? "",
          name: block.name ?? "",
          args,
        })
      }
    }
    return events.length > 0 ? events : null
  }

  return null
}
