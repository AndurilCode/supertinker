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

  const args = [
    "-p", ctx.userPrompt,
    "--system-prompt", ctx.systemPrompt,
    "--output-format", "json",
    "--json-schema", schema,
    "--dangerously-skip-permissions",
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  const raw = await run("claude", args, ctx.cwd, ctx.logFile)

  const parsed = JSON.parse(raw.trim())
  if (parsed.output !== undefined && parsed.choice !== undefined) return parsed
  if (parsed.structured_output?.output !== undefined && parsed.structured_output?.choice !== undefined) return parsed.structured_output
  if (parsed.result) return JSON.parse(parsed.result)
  throw new Error(`Unexpected Claude output shape: ${raw.slice(0, 200)}`)
}
