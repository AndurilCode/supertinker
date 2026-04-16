/**
 * sanitize-json — strips markdown fences from agent output that should be raw JSON
 *
 * LLMs frequently wrap JSON output in ```json ... ``` fences despite explicit
 * instructions not to. This hook intercepts PostAgent and strips fences from
 * the result.output before it reaches guardrails and context storage.
 *
 * Only activates when the output looks like fenced JSON (starts with ```).
 * Mutates result.output in-place (PostAgent events are mutable).
 */

import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

const FENCE_START = /^```(?:json)?\s*\n?/i
const FENCE_END   = /\n?```\s*$/i

export const hook: Hook = {
  name: "sanitize-json",
  description: "Strips markdown code fences from agent output that should be raw JSON",
  events: ["PostAgent"],
  parallel: true,
  priority: 1,  // run before retry (5) and other PostAgent hooks

  handler: async (event: HookEvent): Promise<HookDirective> => {
    const e = event as Extract<HookEvent, { event: "PostAgent" }>
    const trimmed = e.result.output.trim()

    if (FENCE_START.test(trimmed)) {
      e.result.output = trimmed.replace(FENCE_START, "").replace(FENCE_END, "").trim()
    }

    return { action: "continue" }
  },
}
