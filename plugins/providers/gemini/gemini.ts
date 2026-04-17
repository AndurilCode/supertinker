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

// ─── Session sidecar ────────────────────────────────────────────────────────
// Gemini's `--resume` takes an index ("latest" or an integer position from
// `--list-sessions`), NOT a UUID. We can't safely resume by captured
// session_id across parallel runs. The sidecar still records the id for
// observability/debugging; resume isn't attempted.

function sessionPathFor(logFile: string): string { return logFile.replace(/\.log$/, ".session") }
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

// ─── Sentinel parsing ───────────────────────────────────────────────────────
// Gemini has no structured-output flag equivalent to codex --output-schema,
// so we still rely on the text-sentinel contract for choice extraction.

function parseSentinel(raw: string, options: string[]): { output: string; choice: string } | null {
  const m = raw.match(/---CHOICE---\s*\n\s*(\S+)\s*\n\s*---END---/)
  if (!m) return null
  const choice = m[1].trim()
  if (!options.includes(choice)) return null
  const output = raw.slice(0, raw.indexOf("---CHOICE---")).trim()
  return { output, choice }
}

// ─── Streaming JSONL event parser ───────────────────────────────────────────
// Gemini `-o stream-json` emits newline-delimited events. We care about:
//   • init       { session_id, model }       → session metadata
//   • message    { role:"assistant", content, delta? }   → output chunks
//   • result     { status, stats }           → terminal marker

interface StreamedResult {
  output:     string
  sessionId?: string
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
    let sessionId: string | undefined
    let failed = false

    const onAbort = () => killWithEscalation(proc)
    signal?.addEventListener("abort", onAbort, { once: true })

    const handleLine = (line: string) => {
      if (!line.trim()) return
      appendFileSync(logFile, line + "\n")
      let evt: any
      try { evt = JSON.parse(line) } catch { return }

      if (evt.type === "init" && typeof evt.session_id === "string") sessionId = evt.session_id

      if (evt.type === "message" && evt.role === "assistant" && typeof evt.content === "string") {
        output += evt.content
        if (onChunk) { try { onChunk(evt.content) } catch {} }
      }

      if (evt.type === "result" && evt.status && evt.status !== "success") failed = true
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split(/\r?\n/)
      buf = lines.pop() ?? ""
      for (const line of lines) handleLine(line)
    })
    proc.stderr!.on("data", (chunk: Buffer) => {
      // Gemini spews permission warnings for unreadable /tmp dirs; keep them
      // out of the hot log but preserve real errors.
      const txt = chunk.toString()
      err += txt
      appendFileSync(logFile, `[stderr] ${txt}`)
    })
    proc.on("close", code => {
      signal?.removeEventListener("abort", onAbort)
      if (buf.trim()) handleLine(buf)
      if (signal?.aborted) return rej(new Error(`Aborted: ${(signal as any).reason?.message ?? "signal"}`))
      if (code !== 0 || failed) return rej(new Error(`gemini exit ${code}${failed ? " (result status not success)" : ""}: ${err.slice(0, 400)}`))
      res({ output, sessionId })
    })
    proc.stdin!.end()
  })
}

// ─── Public entrypoint ──────────────────────────────────────────────────────

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const hasOptions = ctx.options.length > 0

  // Prompt: fold system prompt into user prompt (gemini has no separate
  // system-prompt flag in headless mode). When options are present, append
  // the sentinel contract.
  const prompt = [
    ctx.systemPrompt,
    "",
    ctx.userPrompt,
    ...(hasOptions
      ? [
          "",
          "You MUST end your response with this exact sentinel block, selecting one option:",
          "",
          "---CHOICE---",
          "<label>",
          "---END---",
          "",
          `Available options: ${ctx.options.join(" | ")}`,
        ]
      : []),
  ].join("\n")

  // Default approval-mode is "plan" (read-only). Opt-in writes via env var.
  const approval = process.env.GEMINI_APPROVAL_MODE ?? "plan"

  const args: string[] = [
    "-p", prompt,
    "-o", "stream-json",
    "--approval-mode", approval,
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  // Dashboard meta sidecar
  const metaPath = ctx.logFile.replace(/\.log$/, ".meta.json")
  writeFileSync(metaPath, JSON.stringify({
    provider: "gemini", cwd: ctx.cwd, model: ctx.model ?? null,
  }))

  const streamed = await runStreaming("gemini", args, ctx.cwd, ctx.logFile, ctx.onChunk, ctx.signal)
  if (streamed.sessionId) writeSession(ctx.logFile, streamed.sessionId)

  if (hasOptions) {
    const parsed = parseSentinel(streamed.output, ctx.options)
    if (parsed) return { ...parsed, metadata: { provider: "gemini", sessionId: streamed.sessionId, streaming: true } }
    throw new Error(`gemini: no ---CHOICE--- sentinel. Options: ${ctx.options.join("|")}. Output tail: ${streamed.output.slice(-400)}`)
  }

  return {
    output: streamed.output.trim(),
    choice: "ok",
    metadata: { provider: "gemini", sessionId: streamed.sessionId, streaming: true },
  }
}
