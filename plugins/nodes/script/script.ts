import { spawnSync } from "child_process"
import type { NodeTypeDefinition } from "../../../supertinker"

// Expose every context key as $CTX_<UPPER_KEY> so scripts can read upstream
// outputs without unsafe in-place [key] interpolation. Names are normalised
// to A-Z 0-9 _ so JSON-y keys still produce a valid env var.
function buildEnv(ctx: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(ctx)) {
    env[`CTX_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = v
  }
  return env
}

export const node: NodeTypeDefinition = {
  type: "script",
  description: "Runs a shell command. Context is exposed as $CTX_<KEY> env vars; node.stdin names a context key whose value is piped to stdin. Stdout (trimmed) becomes the node's output.",
  schema: {
    requires: ["instruction", "options"],
    optional: ["stdin", "cwd", "slice", "timeout"],
    example: {
      id:          "transform",
      type:        "script",
      instruction: "jq '.summary'",
      stdin:       "plan",
      options:     { done: "next" },
    } as any,
  },
  validate: (n) => {
    if (!n.options?.done) return `script "${n.id}" requires options.done`
    if (!n.instruction)   return `script "${n.id}" requires instruction (the shell command to run)`
    return null
  },
  execute: async (ctx) => {
    // [key] substitution still supported for trivial/safe inline values.
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
      return ctx.errorFallback(`script exited ${result.status}: ${stderr}`)
    }
    ctx.context[ctx.node.id] = (result.stdout ?? "").trimEnd()
    await ctx.saveContext()
    await ctx.executeNode(ctx.node.options!.done, ctx.node.id)
  },
}
