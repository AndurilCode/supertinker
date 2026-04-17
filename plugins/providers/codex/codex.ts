import { spawn, ChildProcess } from "child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs"

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

// ─── Session sidecar (mirrors claude.ts) ────────────────────────────────────
// Codex `exec resume <thread_id>` resumes the same conversation thread, so
// persistent-style nodes keep history across turns instead of re-paying for
// the full context each call.

function sessionPathFor(logFile: string): string { return logFile.replace(/\.log$/, ".session") }
function readExistingSession(logFile: string): string | null {
  const p = sessionPathFor(logFile)
  if (!existsSync(p)) return null
  const id = readFileSync(p, "utf8").trim()
  return id.length > 0 ? id : null
}
function writeSession(logFile: string, sessionId: string): void { writeFileSync(sessionPathFor(logFile), sessionId) }

// ─── Child-process lifecycle (mirrors claude.ts) ────────────────────────────

const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const killAll = () => { for (const p of liveChildren) { try { p.kill("SIGKILL") } catch {} } }
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
  const esc = setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, 2000)
  proc.once("close", () => clearTimeout(esc))
}

// ─── Streaming JSONL event parser ───────────────────────────────────────────
// Codex `--json` emits newline-delimited events. We care about:
//   • thread.started { thread_id }           → session id for resume
//   • item.completed { item:{type,...} }     → agent_message (text), command_execution (tool)
//   • turn.completed                         → terminal success
//   • error / turn.failed                    → surfaced to stderr accumulation

interface StreamedResult {
  output:       string
  sessionId?:   string
  lastAgentText?: string
}

function runStreaming(
  command: string, args: string[], cwd: string, logFile: string,
  onChunk?: (chunk: string) => void, signal?: AbortSignal,
): Promise<StreamedResult> {
  return new Promise((res, rej) => {
    const proc = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    trackChild(proc)
    let buf = "", err = ""
    let output = ""
    let sessionId:    string | undefined
    let lastAgentText: string | undefined
    let turnFailed = false

    const onAbort = () => killWithEscalation(proc)
    signal?.addEventListener("abort", onAbort, { once: true })

    const handleLine = (line: string) => {
      if (!line.trim()) return
      appendFileSync(logFile, line + "\n")
      let evt: any
      try { evt = JSON.parse(line) } catch { return }

      if (evt.type === "thread.started" && typeof evt.thread_id === "string") sessionId = evt.thread_id

      if (evt.type === "item.completed" && evt.item) {
        const item = evt.item
        if (item.type === "agent_message" && typeof item.text === "string") {
          lastAgentText = item.text
          output += item.text
          if (onChunk) { try { onChunk(item.text) } catch {} }
        } else if (item.type === "command_execution" && typeof item.command === "string") {
          if (onChunk) { try { onChunk(`[tool] ${item.command.slice(0, 120)}\n`) } catch {} }
        }
      }

      if (evt.type === "error" || evt.type === "turn.failed") {
        turnFailed = true
        err += (typeof evt.message === "string" ? evt.message : JSON.stringify(evt)) + "\n"
      }
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ""
      for (const line of lines) handleLine(line)
    })
    proc.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString(); appendFileSync(logFile, `[stderr] ${chunk}`) })
    proc.on("close", code => {
      signal?.removeEventListener("abort", onAbort)
      if (buf.trim()) handleLine(buf)
      if (signal?.aborted) return rej(new Error(`Aborted: ${(signal as any).reason?.message ?? "signal"}`))
      if (code !== 0 || turnFailed) return rej(new Error(`codex exit ${code}${turnFailed ? " (turn failed)" : ""}: ${err.slice(0, 400)}`))
      res({ output, sessionId, lastAgentText })
    })
    proc.stdin!.end()
  })
}

// ─── Public entrypoint ──────────────────────────────────────────────────────

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const existingSession = readExistingSession(ctx.logFile)
  const hasOptions      = ctx.options.length > 0

  // Prompt: fold system prompt into user prompt (codex exec has no
  // dedicated --system-prompt flag; -c instructions is TOML-only).
  const prompt = ctx.systemPrompt ? `${ctx.systemPrompt}\n\n${ctx.userPrompt}` : ctx.userPrompt

  // Structured output via --output-schema. Codex requires
  // additionalProperties:false at every object level.
  let schemaPath: string | undefined
  if (hasOptions) {
    schemaPath = ctx.logFile.replace(/\.log$/, ".schema.json")
    writeFileSync(schemaPath, JSON.stringify({
      type: "object",
      additionalProperties: false,
      required: ["output", "choice"],
      properties: {
        output: { type: "string" },
        choice: { type: "string", enum: ctx.options },
      },
    }))
  }

  // Sandbox default read-only; opt-in to workspace-write / danger-full-access
  // via env var. Approvals default to codex's non-interactive policy (which
  // auto-denies rather than prompting — there's no TTY in exec mode).
  const sandbox = process.env.CODEX_SANDBOX ?? "read-only"

  // `codex exec resume <SESSION_ID> [OPTIONS] <PROMPT>` resumes a thread;
  // `codex exec [OPTIONS] <PROMPT>` starts fresh.
  const subArgs = existingSession ? ["exec", "resume", existingSession] : ["exec"]
  const args: string[] = [
    ...subArgs,
    "--json",
    "--skip-git-repo-check",
    "--sandbox", sandbox,
    ...(ctx.model   ? ["--model", ctx.model]             : []),
    ...(schemaPath  ? ["--output-schema", schemaPath]    : []),
    prompt,
  ]

  // Dashboard meta sidecar
  const metaPath = ctx.logFile.replace(/\.log$/, ".meta.json")
  writeFileSync(metaPath, JSON.stringify({
    provider: "codex", cwd: ctx.cwd, model: ctx.model ?? null,
    sessionId: existingSession ?? null,
  }))

  const streamed = await runStreaming("codex", args, ctx.cwd, ctx.logFile, ctx.onChunk, ctx.signal)
  if (streamed.sessionId) writeSession(ctx.logFile, streamed.sessionId)

  // With schema, the final agent_message.text is the JSON object.
  if (hasOptions) {
    const raw = streamed.lastAgentText?.trim() ?? streamed.output.trim()
    try {
      const parsed = JSON.parse(raw)
      if (typeof parsed.output === "string" && typeof parsed.choice === "string" && ctx.options.includes(parsed.choice)) {
        return {
          output: parsed.output, choice: parsed.choice,
          metadata: { provider: "codex", sessionId: streamed.sessionId, streaming: true },
        }
      }
    } catch {}
    throw new Error(`codex: schema output did not parse. Options: ${ctx.options.join("|")}. Last: ${raw.slice(-400)}`)
  }

  // No options → persistent-style call, emit non-empty marker so the retry
  // hook doesn't misread this as a failed sentinel.
  return {
    output: streamed.output.trim(),
    choice: "ok",
    metadata: { provider: "codex", sessionId: streamed.sessionId, streaming: true },
  }
}
