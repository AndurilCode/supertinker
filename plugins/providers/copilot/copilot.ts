import { spawn } from "child_process"
import { appendFileSync } from "fs"

interface ProviderContext {
  userPrompt:   string
  systemPrompt: string
  options:      string[]
  cwd:          string
  model?:       string
  logFile:      string
}

interface AgentResult {
  output: string
  choice: string
  transcriptPath?: string
}

function run(command: string, args: string[], cwd: string, logFile: string): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(command, args, { cwd, env: process.env })
    let out = "", err = ""
    proc.stdout.on("data", (chunk: Buffer) => {
      const txt = chunk.toString(); out += txt
      appendFileSync(logFile, txt)
    })
    proc.stderr.on("data", (chunk: Buffer) => { err += chunk.toString() })
    proc.on("close", code => code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err.slice(0, 300)}`)))
    proc.stdin.end()
  })
}

function extractContent(raw: string): string {
  const lines = raw.trim().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i])
      if (evt.type === "assistant.message" && evt.data?.content) return evt.data.content
    } catch { /* not JSON */ }
  }
  return raw
}

function extractSessionId(raw: string): string | null {
  for (const line of raw.trim().split("\n")) {
    try {
      const evt = JSON.parse(line)
      if (evt.type === "session.start" && evt.data?.sessionId) return evt.data.sessionId
    } catch { /* not JSON */ }
  }
  return null
}

function parseSentinel(raw: string, options: string[]): AgentResult | null {
  const m = raw.match(/---CHOICE---\s*\n\s*(\S+)\s*\n\s*---END---/)
  if (!m) return null
  const choice = m[1].trim()
  if (!options.includes(choice)) return null
  const output = raw.slice(0, raw.indexOf("---CHOICE---")).trim()
  return { output, choice }
}

export async function invoke(ctx: ProviderContext, retry = false): Promise<AgentResult> {
  const retryHint = retry
    ? "\n\nWARNING: Your previous response was missing the ---CHOICE--- sentinel block. Include it now."
    : ""

  const fullPrompt = `${ctx.systemPrompt}\n\n${ctx.userPrompt}${retryHint}`
  const args = [
    "-p", fullPrompt,
    "--autopilot",
    "--yolo",
    "--output-format", "json",
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  const raw = await run("copilot", args, ctx.cwd, ctx.logFile)
  const content = extractContent(raw)
  const result = parseSentinel(content, ctx.options)

  if (!result && !retry) return invoke(ctx, true)
  if (!result) throw new Error(`No valid sentinel after retry. Output: ${content.slice(0, 300)}`)

  const sessionId = extractSessionId(raw)
  if (sessionId) {
    result.transcriptPath = `${process.env.HOME}/.copilot/session-state/${sessionId}/events.jsonl`
  }

  return result
}
