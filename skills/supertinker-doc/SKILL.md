---
name: supertinker-doc
description: Reference guide for authoring supertinker plugins — workflows, providers, hooks, storage adapters, and CLI commands. Use this skill whenever the user wants to create, extend, or understand how to build a new workflow, provider, hook, storage adapter, or CLI command for supertinker.
---

# supertinker Plugin Authoring Reference

supertinker is extended through five plugin types. All are TypeScript (or JS) files dropped into a search-path directory — no build step, no registration.

## Search Path & Discovery

supertinker searches for plugins in this priority order (first match wins for providers/workflows/storage; all hooks merge):

```
.supertinker/           ← project-local (highest priority)
~/.supertinker/         ← user-global
<supertinker-install>/  ← built-in (lowest priority)
```

Each type has its own subdirectory: `hooks/`, `providers/`, `workflows/`, `storage/`.

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
| `{ action: "pause", reason: string }` | PreAgent, PreProvider, PostAgent, GuardrailFail, SubworkflowStart | Pause the run |
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

## Quick Reference

| Plugin type | Drop file in | Export | Key constraint |
|-------------|-------------|--------|----------------|
| Workflow | `.supertinker/workflows/` | `export const workflow: Workflow` | filename must be `<id>.workflow.ts` |
| Provider | `.supertinker/providers/` | `export async function invoke(ctx): Promise<AgentResult>` | name must match `command` in registry |
| Hook | `.supertinker/hooks/` | `export const hook: Hook` | all hooks from all paths are merged and run |
| Storage | `.supertinker/storage/` | `export const storage: Partial<StorageAdapter>` | only one storage adapter is active; partial overrides filesystem defaults |
| Command | `.supertinker/commands/` | `export const command: CommandPlugin` | filename is the command name; first match in search path wins |
