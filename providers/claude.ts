import { spawn } from "child_process"
import { appendFileSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"
import type { DisplayEvent, TranscriptMapper } from "../display-protocol.js"

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

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const schema = JSON.stringify({
    type: "object",
    required: ["output", "choice"],
    properties: {
      output: { type: "string" },
      choice: { type: "string", enum: ctx.options },
    },
  })

  const sessionId = randomUUID()

  // Write meta sidecar for dashboard
  const metaPath = ctx.logFile.replace(/\.log$/, ".meta.json")
  writeFileSync(metaPath, JSON.stringify({
    transcriptPath: `${process.env.HOME}/.claude/projects/${sessionId}.jsonl`,
    provider: "claude",
  }))

  const args = [
    "-p", ctx.userPrompt,
    "--system-prompt", ctx.systemPrompt,
    "--output-format", "json",
    "--json-schema", schema,
    "--dangerously-skip-permissions",
    "--session-id", sessionId,
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  const raw = await run("claude", args, ctx.cwd, ctx.logFile)

  const parsed = JSON.parse(raw.trim())
  let result: AgentResult
  if (parsed.output !== undefined && parsed.choice !== undefined) result = parsed
  else if (parsed.structured_output?.output !== undefined && parsed.structured_output?.choice !== undefined) result = parsed.structured_output
  else if (parsed.result) result = JSON.parse(parsed.result)
  else throw new Error(`Unexpected Claude output shape: ${raw.slice(0, 200)}`)

  result.transcriptPath = parsed.session_id
    ? `${process.env.HOME}/.claude/projects/${parsed.session_id}.jsonl`
    : undefined

  return result
}

export const mapTranscript: TranscriptMapper = (line: string) => {
  let parsed: any
  try { parsed = JSON.parse(line) } catch { return null }

  const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now()

  // Skip non-display events
  if (parsed.type === "queue-operation" || parsed.type === "attachment" || parsed.type === "system") return null

  // User events — look for tool_result
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

  // Assistant events
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
