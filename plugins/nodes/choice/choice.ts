import { spawnSync } from "child_process"
import type { NodeTypeDefinition } from "../../../supertinker"

function buildEnv(ctx: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(ctx)) {
    env[`CTX_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = v
  }
  return env
}

export const node: NodeTypeDefinition = {
  type: "choice",
  description: "Runs a shell command; the first line of stdout must equal one of the options keys, and that option's target is taken. Same context wiring as script ($CTX_<KEY> env + node.stdin pipe).",
  schema: {
    requires: ["instruction", "options"],
    optional: ["stdin", "cwd", "slice", "timeout"],
    example: {
      id:          "decide",
      type:        "choice",
      instruction: "[ -n \"$CTX_PLAN\" ] && echo continue || echo retry",
      stdin:       "plan",
      options:     { continue: "next", retry: "plan-again" },
    } as any,
  },
  validate: (n) => {
    if (!n.instruction) return `choice "${n.id}" requires instruction`
    if (!n.options || Object.keys(n.options).length === 0)
      return `choice "${n.id}" requires non-empty options`
    return null
  },
  execute: async (ctx) => {
    const cmd = (ctx.node.instruction ?? "").replace(/\[([^\]\s]+)\]/g, (m, k) => ctx.context[k] ?? m)

    const stdinKey = (ctx.node as any).stdin as string | undefined
    const input    = stdinKey ? (ctx.context[stdinKey] ?? "") : undefined

    const result = spawnSync(cmd, {
      cwd:       ctx.node.cwd ?? process.cwd(),
      shell:     true,
      encoding:  "utf8",
      input,
      env:       buildEnv(ctx.context),
      timeout:   ctx.node.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").slice(0, 500)
      return ctx.errorFallback(`choice exited ${result.status}: ${stderr}`)
    }

    const stdout = (result.stdout ?? "").trim()
    const label  = stdout.split(/\r?\n/)[0]?.trim() ?? ""
    const next   = ctx.node.options![label]
    if (!next) {
      const valid = Object.keys(ctx.node.options!).join(", ")
      return ctx.errorFallback(`choice "${ctx.node.id}" got label "${label}" — not in options: ${valid}`)
    }

    ctx.context[ctx.node.id] = stdout
    await ctx.saveContext()
    await ctx.executeNode(next, ctx.node.id)
  },
}
