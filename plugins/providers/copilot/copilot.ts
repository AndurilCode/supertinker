import { spawn } from "child_process"
import { appendFileSync, writeFileSync } from "fs"
import type { DisplayEvent, TranscriptMapper } from "../../../display-protocol.js"

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
    let metaWritten = false
    proc.stdout.on("data", (chunk: Buffer) => {
      const txt = chunk.toString(); out += txt; appendFileSync(logFile, txt)
      // Write meta on first session.start event
      if (!metaWritten && txt.includes('"session.start"')) {
        try {
          for (const line of txt.split("\n")) {
            const evt = JSON.parse(line)
            if (evt.type === "session.start" && evt.data?.sessionId) {
              const metaPath = logFile.replace(/\.log$/, ".meta.json")
              writeFileSync(metaPath, JSON.stringify({
                transcriptPath: `${process.env.HOME}/.copilot/session-state/${evt.data.sessionId}/events.jsonl`,
                provider: "copilot",
              }))
              metaWritten = true
              break
            }
          }
        } catch {}
      }
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

export const mapTranscript: TranscriptMapper = (line: string) => {
  let parsed: any
  try { parsed = JSON.parse(line) } catch { return null }

  const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now()
  const type = parsed.type as string

  // Skip non-display events
  if (["session.start", "session.info", "session.model_change", "session.shutdown",
       "hook.start", "hook.end", "subagent.selected",
       "assistant.turn_start", "assistant.turn_end"].includes(type)) return null

  if (type === "assistant.message") {
    const events: DisplayEvent[] = []
    const data = parsed.data

    if (data?.reasoningText) {
      events.push({ t: "thinking", ts, text: data.reasoningText })
    }
    if (data?.content) {
      events.push({ t: "text", ts, text: data.content, final: true })
    }
    if (Array.isArray(data?.toolRequests)) {
      for (const tr of data.toolRequests) {
        const args: Record<string, string> = {}
        if (tr.arguments) {
          for (const [k, v] of Object.entries(tr.arguments as Record<string, unknown>)) {
            const s = typeof v === "string" ? v : JSON.stringify(v)
            args[k] = s.length > 100 ? s.slice(0, 100) + "..." : s
          }
        }
        events.push({ t: "tool_start", ts, id: tr.toolCallId ?? "", name: tr.name ?? "", args })
      }
    }
    return events.length > 0 ? events : null
  }

  if (type === "tool.execution_start") {
    const data = parsed.data
    const args: Record<string, string> = {}
    if (data?.arguments) {
      for (const [k, v] of Object.entries(data.arguments as Record<string, unknown>)) {
        const s = typeof v === "string" ? v : JSON.stringify(v)
        args[k] = s.length > 100 ? s.slice(0, 100) + "..." : s
      }
    }
    return { t: "tool_start", ts, id: data?.toolCallId ?? "", name: data?.toolName ?? "", args }
  }

  if (type === "tool.execution_complete") {
    const data = parsed.data
    const result = typeof data?.result?.content === "string" ? data.result.content.slice(0, 200) : "(done)"
    return { t: "tool_end", ts, id: data?.toolCallId ?? "", name: "", result }
  }

  if (type === "subagent.started") {
    const data = parsed.data
    return { t: "subagent_start", ts, id: data?.toolCallId ?? "", name: data?.agentName ?? "", desc: data?.agentDescription ?? "" }
  }

  if (type === "subagent.completed") {
    const data = parsed.data
    return { t: "subagent_end", ts, id: data?.toolCallId ?? "", tools: data?.totalToolCalls ?? 0, duration_ms: data?.durationMs ?? 0 }
  }

  if (type === "user.message") return null
  if (type === "system.notification") return null

  return null
}
