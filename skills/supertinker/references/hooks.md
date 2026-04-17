# Hooks

A hook listens to orchestrator lifecycle events and returns a directive that can alter execution. Place it in `.supertinker/hooks/my-hook.ts`.

## Required Export

```typescript
import type { Hook } from "supertinker"

export const hook: Hook = {
  name:        "my-hook",
  description: "What it does",           // optional but recommended
  events:      ["PreAgent", "PostAgent"], // see event list below
  parallel:    true,                      // default: true; false = runs before parallel hooks
  priority:    50,                        // default: 50; lower number = runs first
  timeout:     30000,                     // ms; default: 30000
  handler:     async (event) => {
    // inspect event, return a directive
    return { action: "continue" }
  },
}
```

## All Hook Events

| Event | When it fires | Payload highlights |
|-------|--------------|-------------------|
| `RunStart` | Before graph execution begins | `workflow`, `initialContext` |
| `RunEnd` | After terminal node reached | `terminal: "done" \| "failed"`, `finalContext` |
| `NodeStart` | Top of executeNode for **every** node (built-in or custom), before any type-specific event | `nodeId`, `nodeType`, `from: string \| null` |
| `NodeEnd` | Just before successful flow leaves the node (terminals included; not fired on the error path — see `Error`) | `nodeId`, `nodeType`, `to: string \| null` |
| `PreAgent` | Before agent invocation (context mutable here) | `nodeId`, `agent`, `provider`, `userPrompt`, `systemPrompt`, `slicedContext` |
| `PostAgent` | After agent returns | `nodeId`, `result: AgentResult`, `transcriptPath?` |
| `PreProvider` | Just before provider.invoke() call | `nodeId`, `provider`, `userPrompt`, `systemPrompt`, `cwd`, `model?`, `logFile` |
| `Paused` | Run entered paused state | `nodeId`, `reason?`, `stateFile` |
| `Resumed` | Run resumed from pause | `nodeId`, `choice` |
| `ForkStart` | Before parallel branches launch | `nodeId`, `targets: string[]` |
| `ForkJoin` | After all branches complete | `nodeId`, `joinedFrom: string[]` |
| `GuardrailFail` | When a guardrail check fails | `nodeId`, `phase: "pre" \| "post"`, `reason` |
| `SubworkflowStart` | Before nested workflow executes | `nodeId`, `innerWorkflow` |
| `SubworkflowEnd` | After nested workflow completes | `nodeId`, `innerContext` |
| `Error` | On node error before fallback | `nodeId`, `error`, `fallbackNodeId?` |

All event objects also carry: `event`, `runId`, `runDir`, `context` (frozen except in PreAgent/PostAgent), `timestamp`.

## Directives

Return one of these from `handler`. Unsupported directives for an event silently downgrade to `continue`.

| Directive | Supported events | Effect |
|-----------|-----------------|--------|
| `{ action: "continue" }` | all | Normal execution continues |
| `{ action: "skip" }` | PreAgent, PreProvider | Skip this node, go to fallback |
| `{ action: "pause", reason: string }` | PreAgent, PreProvider, PostAgent, GuardrailFail, SubworkflowStart, NodeStart | Pause the run |
| `{ action: "redirect", targetNodeId: string }` | PreAgent, PreProvider, PostAgent | Jump to a different node |
| `{ action: "abort", reason: string }` | all | Throw — terminates the run immediately |

**Conflict resolution (when multiple hooks fire):** highest-rank wins (`abort > pause > redirect > skip > continue`). Equal rank: lower `priority` number wins.

## Example: Pause on Keyword in Output

```typescript
import type { Hook } from "supertinker"

export const hook: Hook = {
  name:    "pause-on-keyword",
  events:  ["PostAgent"],
  handler: async (event) => {
    if (event.event !== "PostAgent") return { action: "continue" }
    if (event.result.output.includes("STOP")) {
      return { action: "pause", reason: "agent output contained STOP keyword" }
    }
    return { action: "continue" }
  },
}
```

## Example: Mutate Context in PreAgent

```typescript
import type { Hook } from "supertinker"

export const hook: Hook = {
  name:    "inject-timestamp",
  events:  ["PreAgent"],
  handler: async (event) => {
    if (event.event !== "PreAgent") return { action: "continue" }
    // context is mutable in PreAgent
    event.context["_timestamp"] = new Date().toISOString()
    return { action: "continue" }
  },
}
```

## Custom event names

`HookEventName` is `string`. The names in the table above are the built-ins, but a custom node-type plugin (see `nodes.md`) can emit any event name via `ctx.emitHook("MyEvent", { ... })`, and a hook subscribes by listing the same string in its `events` array. The plugin author owns the contract — directive support (`pause`, `redirect`, `skip`) is **not** validated for custom event names, so document what each directive means in your plugin.

```typescript
// In a custom node's execute(): fire your own lifecycle event
await ctx.emitHook("LoopIteration", { i, total: ctx.node.targets!.length })

// In a hook plugin: subscribe to it by name
export const hook: Hook = {
  name:    "loop-progress",
  events:  ["LoopIteration"],
  handler: async (event) => {
    // event.event === "LoopIteration"; payload fields are on event itself
    return { action: "continue" }
  },
}
```
