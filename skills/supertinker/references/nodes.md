# Custom Node Types

A node-type plugin lets you add a new value for `node.type` (alongside the built-ins `fork`, `join`, `done`, `failed`, `paused`, `subworkflow`). Reach for a custom node type when the work is **structural and reusable** across workflows — emitting a static value, running a shell command, fetching a URL, evaluating a switch expression — anything that doesn't need an agent and isn't worth its own whole workflow. Use a hook for cross-cutting observability/control; use a workflow for multi-step plans; use a node type when you want a new primitive in the graph DSL itself.

## File Layout

Drop your plugin at `plugins/nodes/<name>/<name>.ts` during development, or install it to `<SEARCH_DIR>/nodes/<name>.ts`. Search-path resolution is the same as other plugins (project > user > built-in, first match wins). **You cannot shadow a built-in type** — the loader skips any plugin whose `type` matches `fork`, `join`, `done`, `failed`, `paused`, or `subworkflow` and logs a warning.

## Required Export

```typescript
import type { NodeTypeDefinition } from "supertinker"

export const node: NodeTypeDefinition = {
  type:        "my-type",        // value users write as node.type
  description: "What it does",   // shown in the meta architect's [nodeCatalog]
  schema: {
    requires: ["instruction", "options"],
    optional: ["cwd", "slice"],
    example: {
      id:          "demo",
      type:        "my-type",
      instruction: "...",
      options:     { done: "next" },
    },
  },
  validate: (node, graph) => null,         // return null on success, or an error message
  execute:  async (ctx) => { /* ... */ },  // see contract below
}
```

## NodeTypeDefinition

```typescript
interface NodeTypeDefinition {
  type:         string
  description?: string
  schema?: {
    requires?: string[]            // which GraphNode fields your type needs
    optional?: string[]
    example?:  Partial<GraphNode>  // what the meta architect copies verbatim
  }
  validate?: (node: GraphNode, graph: Graph) => string | null   // null = ok
  execute:   (ctx: NodeExecuteCtx) => Promise<void>
}
```

## NodeExecuteCtx

`execute` is responsible for **driving flow** — call `ctx.executeNode(next, ctx.node.id)` to advance, `ctx.writePause(...)` to pause, `ctx.errorFallback(...)` to route to the fallback node, or just return for terminal-like behavior. The runtime emits `NodeStart` before `execute` and `NodeEnd` after it returns.

```typescript
interface NodeExecuteCtx {
  node:        GraphNode               // the node being executed
  fromNodeId:  string | null           // who routed here (null on start)
  context:     Context                 // mutable; same reference as RunState
  runId:       string
  runDir:      string
  storage:     StorageAdapter

  // Helpers — the stable surface custom nodes should rely on:
  slice:           (keys?: string[]) => Context
  render:          (instruction?: string, keys?: string[]) => string
  saveContext:     () => Promise<void>
  executeNode:     (nodeId: string, fromNodeId: string | null) => Promise<void>
  invokeAgent:     (node: GraphNode, pre?: { userPrompt: string; systemPrompt: string }) => Promise<AgentResult>
  // Wraps invokeAgent with PreAgent → PreProvider → invokeAgent → PostAgent
  // emission and directive handling — same semantics as the built-in standard
  // path. Returns { redirected: true } when a hook redirected/skipped/paused
  // and the caller should stop driving execution itself.
  runAgent:        (node: GraphNode) => Promise<AgentResult | { redirected: true }>
  emitHook:        (event: string, payload: Record<string, unknown>) => Promise<HookDirective>
  writePause:      (reason?: string) => Promise<void>
  errorFallback:   (error: string) => Promise<void>
  resolveFallback: () => string
  log:             (line: string) => Promise<void>
}
```

## Built-in Examples: `script` and `choice`

The bundled `plugins/nodes/script` and `plugins/nodes/choice` plugins together cover most "deterministic middleware between agents" needs — JSON transformations, format conversions, validators, branching on shell exit logic, etc. Both:

- Expose every context key as `$CTX_<UPPER_KEY>` env var (non-`A-Z 0-9` characters become `_`), so you can read upstream output safely without inlining it into the command string.
- Accept an optional `stdin` field naming a context key whose value is piped to the command's stdin — the right way to pass JSON or any value with quotes/newlines.
- Still support `[key]` interpolation in the `instruction` for trivial inline values, but env/stdin is preferred.

```typescript
// plugins/nodes/script/script.ts (abridged)
import { spawnSync } from "child_process"
import type { NodeTypeDefinition } from "supertinker"

function buildEnv(ctx: Record<string, string>): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env }
  for (const [k, v] of Object.entries(ctx)) {
    env[`CTX_${k.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`] = v
  }
  return env
}

export const node: NodeTypeDefinition = {
  type: "script",
  description: "Runs a shell command. $CTX_<KEY> env + node.stdin pipe; stdout becomes the node's output.",
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
    if (!n.instruction)   return `script "${n.id}" requires instruction`
    return null
  },
  execute: async (ctx) => {
    const cmd = (ctx.node.instruction ?? "").replace(/\[([^\]\s]+)\]/g, (m, k) => ctx.context[k] ?? m)
    const stdinKey = (ctx.node as any).stdin as string | undefined
    const input    = stdinKey ? (ctx.context[stdinKey] ?? "") : undefined

    const result = spawnSync(cmd, {
      cwd: ctx.node.cwd ?? process.cwd(), shell: true, encoding: "utf8",
      input, env: buildEnv(ctx.context),
      timeout: ctx.node.timeout ?? 60_000, maxBuffer: 10 * 1024 * 1024,
    })
    if (result.status !== 0) return ctx.errorFallback(
      `script exited ${result.status}: ${(result.stderr ?? "").slice(0, 500)}`
    )
    ctx.context[ctx.node.id] = (result.stdout ?? "").trimEnd()
    await ctx.saveContext()
    await ctx.executeNode(ctx.node.options!.done, ctx.node.id)
  },
}
```

`choice` shares the exact same context wiring but uses `options` for **deterministic branching**: the **first line of stdout** must equal one of the options keys, and that option's target is taken. If stdout doesn't match any key, the run routes through `errorFallback` to the fallback node.

```typescript
// plugins/nodes/choice/choice.ts (abridged)
export const node: NodeTypeDefinition = {
  type: "choice",
  description: "Runs a shell command; first line of stdout selects the next branch from options.",
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
  // execute: same env/stdin wiring as script, then:
  //   const label = stdout.split(/\r?\n/)[0]?.trim() ?? ""
  //   const next  = ctx.node.options![label]
  //   if (!next) return ctx.errorFallback(`label "${label}" not in options`)
  //   ctx.context[ctx.node.id] = stdout
  //   await ctx.saveContext()
  //   await ctx.executeNode(next, ctx.node.id)
}
```

### Pipeline pattern

Use `script` for transformation, `choice` for routing. Together they cover most deterministic glue between agent steps:

```
agent (produces JSON)
  → script  (jq '.summary'   stdin: "agent-id")     → context["transform"]
  → choice  ([ -n "$CTX_TRANSFORM" ] && echo yes || echo no)
       yes → next agent
       no  → retry / paused
```

> ⚠️ **Shell-injection caveat:** both `script` and `choice` run `instruction` through `shell: true` and pass values via env, not interpolation. Authored workflows are trusted input by design — but if you ever wire `instruction` from a free-form user prompt, sanitise it first.

## Architect Discoverability

The meta architect sees your plugin through the `[nodeCatalog]` context key (built by `buildNodeCatalog()`):

```
Custom node types (2):
- choice: Runs a shell command; the first line of stdout must equal one of the options keys, ...
  requires: instruction, options
  example: {"id":"decide","type":"choice","instruction":"...","stdin":"plan","options":{"continue":"next","retry":"plan-again"}}
- script: Runs a shell command. $CTX_<KEY> env + node.stdin pipe; stdout becomes the node's output.
  requires: instruction, options
  example: {"id":"transform","type":"script","instruction":"jq '.summary'","stdin":"plan","options":{"done":"next"}}
```

Keep `description`, `schema.requires`, and `schema.example` accurate and minimal — that's the architect's only view of your type.

## Rules

- `type` must not match a built-in (`fork`, `join`, `done`, `failed`, `paused`, `subworkflow`). The loader rejects collisions at startup.
- `execute` **must advance flow** — call `ctx.executeNode`, `ctx.writePause`, `ctx.errorFallback`, or just return (the runtime treats a clean return as terminal).
- If your node calls an agent, prefer `ctx.runAgent(node)` over raw `ctx.invokeAgent` so `PreAgent`/`PreProvider`/`PostAgent` hooks fire consistently.
- Store the node's output under `ctx.context[ctx.node.id]` if downstream nodes will reference it via `[node-id]`. Call `ctx.saveContext()` to persist.

## Hook Interaction

`NodeStart` and `NodeEnd` fire automatically for every custom node — no plugin work needed for observability. Existing hooks (`logger`, `events`, `metrics`) pick them up by adding the names to their `events: []` array.

For domain-specific lifecycle events, call `ctx.emitHook("MyCustomEvent", { ... })` with **any string name**. Hook authors subscribe by listing the same string in their `events` array (see "Custom event names" in `hooks.md`). Directive validation is bypassed for custom event names — the plugin author owns what each directive means in that event.

## Manifest

For distribution via `$ST plugins install`:

```json
{
  "name": "my-type",
  "type": "node",
  "description": "What it does",
  "files": ["my-type.ts"],
  "version": "1.0.0"
}
```
