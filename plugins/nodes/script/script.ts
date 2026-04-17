import { spawnSync } from "child_process"
import type { NodeTypeDefinition } from "../../../supertinker"

export const node: NodeTypeDefinition = {
  type: "script",
  description: "Runs a shell command in node.cwd, stores stdout as this node's output, follows options.done",
  schema: {
    requires: ["instruction", "options"],
    optional: ["cwd", "slice", "timeout"],
    example: {
      id:          "count-files",
      type:        "script",
      instruction: "ls -1 | wc -l",
      options:     { done: "next" },
    },
  },
  validate: (n) => {
    if (!n.options?.done) return `script "${n.id}" requires options.done`
    if (!n.instruction)   return `script "${n.id}" requires instruction (the shell command to run)`
    return null
  },
  execute: async (ctx) => {
    // Substitute [key] tokens with context values (no agent-style context dump).
    const cmd = (ctx.node.instruction ?? "").replace(/\[([^\]\s]+)\]/g, (m, k) => ctx.context[k] ?? m)
    const result = spawnSync(cmd, {
      cwd:       ctx.node.cwd ?? process.cwd(),
      shell:     true,
      encoding:  "utf8",
      timeout:   ctx.node.timeout ?? 60_000,
      maxBuffer: 10 * 1024 * 1024,
    })
    if (result.status !== 0) {
      const stderr = (result.stderr ?? "").slice(0, 500)
      return ctx.errorFallback(`script exited ${result.status}: ${stderr}`)
    }
    ctx.context[ctx.node.id] = (result.stdout ?? "").trimEnd()
    await ctx.saveContext()
    const next = ctx.node.options!.done
    await ctx.executeNode(next, ctx.node.id)
  },
}
