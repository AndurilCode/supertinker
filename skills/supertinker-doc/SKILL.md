---
name: supertinker-doc
description: Reference guide for authoring supertinker plugins — workflows, providers, hooks, storage adapters, and CLI commands. Use this skill whenever the user wants to create, extend, or understand how to build a new workflow, provider, hook, storage adapter, or CLI command for supertinker.
---

# supertinker Plugin Authoring Reference

supertinker is extended through six plugin types. All are TypeScript (or JS) files dropped into a search-path directory — no build step, no registration.

## Search Path & Discovery

supertinker searches for plugins in this priority order (first match wins for providers/workflows/storage; all hooks merge):

```
.supertinker/           ← project-local (highest priority)
~/.supertinker/         ← user-global
<supertinker-install>/  ← built-in (lowest priority)
```

Each type has its own subdirectory: `hooks/`, `providers/`, `workflows/`, `storage/`, `commands/`, `nodes/`.

---

## Plugin Manifest

Every plugin shipped via `$ST plugins install` needs a `manifest.json` alongside its implementation:

```json
{
  "name": "my-plugin",
  "type": "hook",
  "description": "What it does",
  "files": ["my-plugin.ts"],
  "version": "1.0.0"
}
```

For manual drop-in plugins (no install command), the manifest is optional.

---

## 1. Workflows

A workflow is a TypeScript file exporting a `Workflow` object. Place it in `.supertinker/workflows/my-workflow.workflow.ts`.

### Full Schema

```typescript
import type { Workflow } from "supertinker"

export const workflow: Workflow = {
  id: "my-workflow",           // must match filename prefix
  description: "What it does",
  graph: {
    id: "my-workflow",
    start: "first-node",       // entry node id
    fallback: "paused",        // node to land on for unhandled errors
    labels: ["next", "done"],  // all choice labels used across nodes
    nodes: [/* GraphNode[] */],
  },
  registry: {
    "my-agent": {
      command: "claude",       // provider name (matches providers/<name>.ts)
      model: "sonnet",         // optional model override
      systemPrompt: "You are...",
    },
  },
  guardrails: {                // optional
    maxIterations: 3,
    pre: [],
    post: [],
  },
}
```

### Node Types

| `type` | Purpose | Required fields |
|--------|---------|-----------------|
| *(omitted)* | Standard — runs an agent | `agent`, `options` |
| `"fork"` | Fan-out: runs N branches in parallel | `targets: string[]` |
| `"join"` | Fan-in: waits for all branches | `waits_for: string[]` |
| `"subworkflow"` | Parses + executes a nested `Workflow` from context | `source: string` (context key) |
| `"done"` | Terminal — success | — |
| `"paused"` | Terminal — awaiting human input | — |
| `"failed"` | Terminal — unrecoverable error | — |

### GraphNode Full Schema

```typescript
{
  id: string,
  type?: "fork" | "join" | "done" | "failed" | "paused" | "subworkflow",

  // Standard nodes only:
  agent?: string,              // key in registry
  instruction?: string,        // prepended to context; use [nodeId] to reference prior outputs (see warning below)
  systemPrompt?: string,       // appended to the agent's base systemPrompt
  options?: Record<string, string>,  // { "label": "next_node_id" }
  slice?: string[],            // limit context keys visible to this agent
  timeout?: number,            // ms; default 600000 (10 min)
  fallback?: string,           // overrides graph.fallback on error
  cwd?: string,                // working directory for the agent

  // Fork nodes only:
  targets?: string[],          // node ids to run in parallel

  // Join nodes only:
  waits_for?: string[],        // node ids that must arrive before continuing

  // Subworkflow nodes only:
  source?: string,             // context key holding a JSON-serialised Workflow
}
```

### Template Variable Warning

The `validate-templates` hook treats any `[word]` in `instruction` fields as a context variable reference. Unresolved references abort the run. Only use `[word]` for node IDs or context keys — use plain text or angle brackets for labels.

### Minimal Linear Workflow Example

```typescript
import type { Workflow } from "supertinker"

export const workflow: Workflow = {
  id: "summarise",
  description: "Summarise a document then review it",
  graph: {
    id: "summarise",
    start: "summarise",
    fallback: "paused",
    labels: ["next", "done"],
    nodes: [
      {
        id: "summarise",
        agent: "writer",
        instruction: "Summarise the document below.",
        options: { next: "review" },
      },
      {
        id: "review",
        agent: "writer",
        instruction: "Review the summary produced in [summarise]. Is it accurate?",
        options: { done: "done" },
      },
      { id: "done",   type: "done"   },
      { id: "paused", type: "paused" },
    ],
  },
  registry: {
    writer: {
      command: "claude",
      systemPrompt: "You are a senior technical writer.",
    },
  },
}
```

### Fork/Join Example

```typescript
nodes: [
  {
    id: "split",
    type: "fork",
    targets: ["branch-a", "branch-b"],
  },
  { id: "branch-a", agent: "worker", options: { done: "merge" } },
  { id: "branch-b", agent: "worker", options: { done: "merge" } },
  {
    id: "merge",
    type: "join",
    waits_for: ["branch-a", "branch-b"],
    // join nodes fall through — add a standard node after merge to continue execution
  },
  { id: "done",   type: "done"   },
  { id: "paused", type: "paused" },
]
```

### Guardrails

Guardrails run before (`pre`) and after (`post`) each agent invocation. If a check fails, the node retries once with feedback injected; if it fails again, the run pauses.

```typescript
guardrails: {
  maxIterations: 3,   // max times any single node can run before forced pause
  pre: [
    // Function form:
    ({ context, nodeId }) => {
      if (!context.input) return { pass: false, reason: "input is missing" }
      return { pass: true }
    },
    // Declarative form (evaluated as JS expression):
    { check: "context.input && context.input.trim().length > 0", reason: "input must not be blank" },
  ],
  post: [
    { check: "output.trim().length > 0", reason: "agent returned empty output" },
    // Variables available: output, choice, nodeId, context
  ],
}
```

---

## 2. Providers

A provider wraps an external agent CLI. Place it in `.supertinker/providers/my-provider.ts`.

### Required Export

```typescript
import type { ProviderContext, AgentResult } from "supertinker"

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  // ...
}
```

### ProviderContext

```typescript
interface ProviderContext {
  userPrompt:   string    // rendered context + instruction
  systemPrompt: string    // agent system prompt
  options:      string[]  // list of valid choice labels (from node.options keys)
  cwd:          string    // resolved working directory
  model?:       string    // optional model override
  logFile:      string    // path to write raw stdout (already opened by orchestrator)
}
```

### AgentResult

```typescript
interface AgentResult {
  output:          string   // the agent's full text response
  choice:          string   // must match one of ctx.options
  transcriptPath?: string   // optional path to a saved transcript
}
```

### Sentinel Block Convention

The orchestrator injects this into the system prompt automatically when a node has `options`. Your provider must parse it from the agent's response:

```
---CHOICE---
<label>
---END---
```

Extract with: `/---CHOICE---\s*(\S+)\s*---END---/`.

### Minimal Provider Example

```typescript
import { spawnSync } from "child_process"
import { writeFileSync } from "fs"
import type { ProviderContext, AgentResult } from "supertinker"

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const input = JSON.stringify({ system: ctx.systemPrompt, prompt: ctx.userPrompt })
  const result = spawnSync("my-cli", ["--json"], {
    input,
    cwd: ctx.cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  })

  const output = result.stdout ?? ""
  writeFileSync(ctx.logFile, output)

  const match = output.match(/---CHOICE---\s*(\S+)\s*---END---/)
  const choice = match?.[1] ?? ctx.options[0] ?? "next"

  return { output, choice }
}
```

---

## 3. Hooks

A hook listens to orchestrator lifecycle events and returns a directive that can alter execution. Place it in `.supertinker/hooks/my-hook.ts`.

### Required Export

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

### All Hook Events

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

### Directives

Return one of these from `handler`. Unsupported directives for an event silently downgrade to `continue`.

| Directive | Supported events | Effect |
|-----------|-----------------|--------|
| `{ action: "continue" }` | all | Normal execution continues |
| `{ action: "skip" }` | PreAgent, PreProvider | Skip this node, go to fallback |
| `{ action: "pause", reason: string }` | PreAgent, PreProvider, PostAgent, GuardrailFail, SubworkflowStart, NodeStart | Pause the run |
| `{ action: "redirect", targetNodeId: string }` | PreAgent, PreProvider, PostAgent | Jump to a different node |
| `{ action: "abort", reason: string }` | all | Throw — terminates the run immediately |

**Conflict resolution (when multiple hooks fire):** highest-rank wins (`abort > pause > redirect > skip > continue`). Equal rank: lower `priority` number wins.

### Example: Pause on Keyword in Output

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

### Example: Mutate Context in PreAgent

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

### Custom event names

`HookEventName` is `string`. The names in the table above are the built-ins, but a custom node-type plugin (see Section 6) can emit any event name via `ctx.emitHook("MyEvent", { ... })`, and a hook subscribes by listing the same string in its `events` array. The plugin author owns the contract — directive support (`pause`, `redirect`, `skip`) is **not** validated for custom event names, so document what each directive means in your plugin.

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

---

## 4. Storage Adapters

A storage adapter customises where run state is persisted. Place it in `.supertinker/storage/storage.ts`. You only need to implement the methods you want to override — the rest delegate to the built-in filesystem adapter.

### Required Export

```typescript
import type { StorageAdapter } from "supertinker"

export const storage: Partial<StorageAdapter> = {
  // override only what you need
}
```

### Full Interface

```typescript
interface StorageAdapter {
  createRun(runId: string): Promise<string>
  // returns runDir — the root path for this run's artifacts

  saveContext(runDir: string, context: Context): Promise<void>
  loadContext(runDir: string): Promise<Context>

  savePause(runDir: string, state: PausedState): Promise<void>
  loadPause(runDir: string): Promise<PausedState>
  pauseExists(runDir: string): Promise<boolean>

  appendLog(runDir: string, line: string): Promise<void>
  saveFile(runDir: string, name: string, content: string): Promise<void>

  saveWorkflow(id: string, content: string): Promise<void>
  // persist a generated workflow to the library

  logPath(runDir: string, nodeId: string): string
  // return the path the provider should write raw stdout to

  resolveWorkflow(name: string): Promise<string | null>
  // given a workflow name/id, return the absolute file path or null

  listWorkflows(): Promise<Array<{
    id: string
    description: string
    file: string
    source: string   // "project" | "library" | "built-in"
  }>>
}
```

### Example: Save Workflows to Project Directory

```typescript
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { StorageAdapter } from "supertinker"

export const storage: Partial<StorageAdapter> = {
  async saveWorkflow(id, content) {
    const dir = join(process.cwd(), ".supertinker", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.workflow.ts`), content)
  },
}
```

---

## 5. Commands

A command plugin adds a new CLI subcommand to supertinker. Place it in `.supertinker/commands/my-command.ts`. Installed commands appear in `supertinker --help`.

### Required Export

```typescript
import type { CommandPlugin } from "supertinker"

export const command: CommandPlugin = {
  name:        "my-command",
  description: "What it does",
  usage:       "my-command <subcommand> [--flag value]",  // optional, shown in --help
  handler:     async (args, get) => {
    // args: argv after the command name (e.g. ["create", "--name", "foo"])
    // get:  helper to extract flag values — get("--name") returns "foo"
  },
}
```

### CommandPlugin Interface

```typescript
interface CommandPlugin {
  name:        string
  description: string
  usage?:      string
  handler:     (args: string[], get: (flag: string) => string | undefined) => Promise<void>
}
```

The `handler` receives:
- `args` — everything after the command name in `argv` (e.g. for `supertinker schedule create --workflow meta`, args is `["create", "--workflow", "meta"]`)
- `get(flag)` — returns the value after `flag` in argv, or `undefined` if not present (e.g. `get("--workflow")` returns `"meta"`)

### Discovery & Invocation

Command plugins are discovered from the same search path as other plugins:

```
.supertinker/commands/   ← project-local (highest priority)
~/.supertinker/commands/ ← user-global
<supertinker-install>/commands/ ← built-in (lowest priority)
```

The filename (minus extension) is the command name. `schedule.ts` → `supertinker schedule`.

First match wins — a project-local command overrides a global one with the same name.

### Example: Minimal Command

```typescript
import type { CommandPlugin } from "supertinker"

export const command: CommandPlugin = {
  name:        "hello",
  description: "Print a greeting",
  usage:       "hello [--name <name>]",
  async handler(args, get) {
    const name = get("--name") ?? "world"
    console.log(`Hello, ${name}!`)
  },
}
```

### Example: Command with Subcommands

```typescript
import type { CommandPlugin } from "supertinker"

export const command: CommandPlugin = {
  name:        "cache",
  description: "Manage the workflow cache",
  usage:       "cache <clear|stats>",
  async handler(args, get) {
    const sub = args[0]
    if (sub === "clear") {
      // clear cache logic
      console.log("Cache cleared.")
    } else if (sub === "stats") {
      // show stats logic
      console.log("Cache entries: 42")
    } else {
      console.log("Usage: supertinker cache <clear|stats>")
    }
  },
}
```

### Manifest

For distribution via `$ST plugins install`, include a `manifest.json`:

```json
{
  "name": "my-command",
  "type": "command",
  "description": "What it does",
  "files": ["my-command.ts"],
  "version": "1.0.0"
}
```

---

## 6. Custom Node Types

A node-type plugin lets you add a new value for `node.type` (alongside the built-ins `fork`, `join`, `done`, `failed`, `paused`, `subworkflow`). Reach for a custom node type when the work is **structural and reusable** across workflows — emitting a static value, running a shell command, fetching a URL, evaluating a switch expression — anything that doesn't need an agent and isn't worth its own whole workflow. Use a hook for cross-cutting observability/control; use a workflow for multi-step plans; use a node type when you want a new primitive in the graph DSL itself.

### File Layout

Drop your plugin at `plugins/nodes/<name>/<name>.ts` during development, or install it to `<SEARCH_DIR>/nodes/<name>.ts`. Search-path resolution is the same as other plugins (project > user > built-in, first match wins). **You cannot shadow a built-in type** — the loader skips any plugin whose `type` matches `fork`, `join`, `done`, `failed`, `paused`, or `subworkflow` and logs a warning.

### Required Export

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

### NodeTypeDefinition

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

### NodeExecuteCtx

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

### Built-in Examples: `script` and `choice`

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

#### Pipeline pattern

Use `script` for transformation, `choice` for routing. Together they cover most deterministic glue between agent steps:

```
agent (produces JSON)
  → script  (jq '.summary'   stdin: "agent-id")     → context["transform"]
  → choice  ([ -n "$CTX_TRANSFORM" ] && echo yes || echo no)
       yes → next agent
       no  → retry / paused
```

> ⚠️ **Shell-injection caveat:** both `script` and `choice` run `instruction` through `shell: true` and pass values via env, not interpolation. Authored workflows are trusted input by design — but if you ever wire `instruction` from a free-form user prompt, sanitise it first.

### Architect Discoverability

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

### Rules

- `type` must not match a built-in (`fork`, `join`, `done`, `failed`, `paused`, `subworkflow`). The loader rejects collisions at startup.
- `execute` **must advance flow** — call `ctx.executeNode`, `ctx.writePause`, `ctx.errorFallback`, or just return (the runtime treats a clean return as terminal).
- If your node calls an agent, prefer `ctx.runAgent(node)` over raw `ctx.invokeAgent` so `PreAgent`/`PreProvider`/`PostAgent` hooks fire consistently.
- Store the node's output under `ctx.context[ctx.node.id]` if downstream nodes will reference it via `[node-id]`. Call `ctx.saveContext()` to persist.

### Hook Interaction

`NodeStart` and `NodeEnd` fire automatically for every custom node — no plugin work needed for observability. Existing hooks (`logger`, `events`, `metrics`) pick them up by adding the names to their `events: []` array.

For domain-specific lifecycle events, call `ctx.emitHook("MyCustomEvent", { ... })` with **any string name**. Hook authors subscribe by listing the same string in their `events` array (see "Custom event names" in Section 3). Directive validation is bypassed for custom event names — the plugin author owns what each directive means in that event.

### Manifest

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

---

## Quick Reference

| Plugin type | Drop file in | Export | Key constraint |
|-------------|-------------|--------|----------------|
| Workflow | `.supertinker/workflows/` | `export const workflow: Workflow` | filename must be `<id>.workflow.ts` |
| Provider | `.supertinker/providers/` | `export async function invoke(ctx): Promise<AgentResult>` | name must match `command` in registry |
| Hook | `.supertinker/hooks/` | `export const hook: Hook` | all hooks from all paths are merged and run |
| Storage | `.supertinker/storage/` | `export const storage: Partial<StorageAdapter>` | only one storage adapter is active; partial overrides filesystem defaults |
| Command | `.supertinker/commands/` | `export const command: CommandPlugin` | filename is the command name; first match in search path wins |
| Node type | `.supertinker/nodes/` | `export const node: NodeTypeDefinition` | `type` must not shadow a built-in; first match in search path wins |
