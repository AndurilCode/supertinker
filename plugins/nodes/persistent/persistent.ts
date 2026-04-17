/**
 * persistent — a node type that keeps an agent alive across events.
 *
 * Pattern: invoke the agent on whatever is in context, store the output, then
 * pause the run. An external trigger (the `subscribe` command, a webhook, a
 * cron, or a plain `supertinker resume`) drops a new event into the run's
 * context and resumes the workflow. The graph's options mapping routes the
 * resume back to the same node, which invokes the agent again — forever, or
 * until another node terminates the graph.
 *
 * Workflow shape:
 *   { id: "support", type: "persistent",
 *     agent: "helper",
 *     instruction: "Answer the user's latest message",
 *     options: { event: "support" } }   // loop on resume --choice event
 *
 * The agent is invoked with `node.options` cleared so the choice sentinel is
 * skipped — persistent agents speak freely. The options map on the node is
 * only used by the resume path to route back to self (or to an off-ramp node
 * that terminates the loop).
 */

import { existsSync, mkdirSync } from "fs"
import { join }                  from "path"
import type { NodeTypeDefinition } from "../../../supertinker"

export const node: NodeTypeDefinition = {
  type: "persistent",
  description:
    "Runs the agent on the current context, then pauses awaiting an external event. " +
    "Pair with options: { <choice>: <self-id> } to loop, or with an off-ramp option to terminate.",
  schema: {
    requires: ["agent", "instruction", "options"],
    optional: ["slice", "timeout", "cwd", "systemPrompt", "fallback", "trigger"],
    example: {
      id:          "support",
      type:        "persistent",
      agent:       "helper",
      instruction: "Answer the user's latest message using prior turns in context",
      options:     { event: "support" },
      // optional: name of the context key that must be non-empty before the
      // agent runs. Defaults to "event" — matches the subscribe / chat pattern.
      trigger:     "event",
    } as any,
  },
  validate: (n) => {
    if (!n.agent)       return `persistent "${n.id}" requires agent`
    if (!n.instruction) return `persistent "${n.id}" requires instruction`
    if (!n.options || Object.keys(n.options).length === 0)
      return `persistent "${n.id}" requires options (at least one choice must route back to self for the loop to continue)`
    return null
  },
  execute: async (ctx) => {
    // Skip the agent call on turns where no trigger value is present. This
    // avoids the noisy first-boot case where the workflow starts before any
    // user event has arrived — the agent would otherwise see empty context
    // and reply with something confused. The node still pauses here, which
    // is what the chat / subscribe drivers expect.
    const triggerKey = ((ctx.node as any).trigger as string | undefined) ?? "event"
    const triggerVal = (ctx.context[triggerKey] ?? "").trim()
    if (!triggerVal) {
      const choices = Object.keys(ctx.node.options!).join(" | ")
      await ctx.writePause(
        `persistent: awaiting first "${triggerKey}" — resume with \`--choice <${choices}>\` ` +
        `after setting context.${triggerKey}`,
      )
      return
    }

    // Per-run sandbox cwd (unless the workflow sets node.cwd explicitly).
    // Claude Code namespaces memory by cwd — if we just use the project dir,
    // every agent turn auto-loads any past Claude Code conversation in that
    // project. Pointing the subprocess at a fresh per-run directory gives
    // the agent a clean slate. The agent still reaches the real project
    // via absolute paths in its instructions / Bash tool.
    const sandbox = ctx.node.cwd ?? join(ctx.runDir, "sandbox")
    if (!ctx.node.cwd && !existsSync(sandbox)) mkdirSync(sandbox, { recursive: true })

    // Strip options for the agent call so no choice sentinel is required —
    // persistent agents produce free-form output. The options map stays on
    // the node for the resume path to use.
    const nodeForAgent = { ...ctx.node, options: undefined, cwd: sandbox }

    const piped = await ctx.runAgent(nodeForAgent)
    if ("redirected" in piped) return

    ctx.context[ctx.node.id] = piped.output
    await ctx.saveContext()

    const choices = Object.keys(ctx.node.options!).join(" | ")
    await ctx.writePause(
      `persistent: awaiting event — resume with \`--choice <${choices}>\` ` +
      `(typically via the subscribe command)`,
    )
  },
}
