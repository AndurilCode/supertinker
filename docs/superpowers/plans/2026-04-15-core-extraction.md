# Core Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract non-orchestration concerns (tmux, template validation, workflow catalog, CLI) from `supertinker.ts` into hooks, storage adapter methods, and a separate `cli.ts`, shrinking the core ~35%.

**Architecture:** Four incremental extractions, each independently testable. Tmux and template validation become hooks. Workflow discovery moves to `StorageAdapter`. CLI becomes a separate entrypoint file that imports the core as a library.

**Tech Stack:** TypeScript, Node.js builtins only (zero dependencies constraint preserved)

---

### Task 1: Extract Tmux into a Hook

**Files:**
- Create: `hooks/tmux-panes.ts`
- Modify: `supertinker.ts:192-203` (delete tmux section)
- Modify: `supertinker.ts:462,471` (delete tmux calls in `invokeAgent`)
- Modify: `supertinker.ts:757` (delete tmux call in `run`)

- [ ] **Step 1: Create `hooks/tmux-panes.ts`**

```ts
import { spawn } from "child_process"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../supertinker.js"

function tmuxRunning(): boolean { return !!process.env.TMUX }

function tmux(action: "new-window" | "kill-window", name: string, cmd?: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    const args = action === "new-window" ? [action, "-n", safe, cmd!] : [action, "-t", safe]
    spawn("tmux", args, { detached: true, stdio: "ignore" }).unref()
  } catch { /* not in tmux */ }
}

export const hook: Hook = {
  name: "tmux-panes",
  description: "Opens tmux panes for orchestrator log and per-agent log tailing",
  events: ["RunStart", "PreProvider", "PostAgent"],
  parallel: true,
  priority: 90,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    switch (event.event) {
      case "RunStart": {
        tmux("new-window", "orch-log", `tail -f ${join(event.runDir, "orchestrator.log")}`)
        break
      }
      case "PreProvider": {
        const e = event as Extract<HookEvent, { event: "PreProvider" }>
        const logFile = join(event.runDir, `${e.nodeId}.log`)
        tmux("new-window", `node-${e.nodeId}`, `tail -f ${logFile}`)
        break
      }
      case "PostAgent": {
        const e = event as Extract<HookEvent, { event: "PostAgent" }>
        setTimeout(() => tmux("kill-window", `node-${e.nodeId}`), 800)
        break
      }
    }
    return { action: "continue" }
  },
}
```

- [ ] **Step 2: Remove tmux functions from `supertinker.ts`**

Delete the entire `// ─── TMUX` section (lines 192-203):
```
// ─── TMUX

function tmuxRunning(): boolean { return !!process.env.TMUX }

function tmux(action: "new-window" | "kill-window", name: string, cmd?: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    const args = action === "new-window" ? [action, "-n", safe, cmd!] : [action, "-t", safe]
    spawn("tmux", args, { detached: true, stdio: "ignore" }).unref()
  } catch { /* not in tmux */ }
}
```

- [ ] **Step 3: Remove tmux call from `invokeAgent`**

In `invokeAgent` (~line 462), remove:
```ts
  tmux("new-window", `node-${node.id}`, `tail -f ${logFile}`)
```

And in the `finally` block (~line 471), remove:
```ts
    setTimeout(() => tmux("kill-window", `node-${node.id}`), 800)
```

The function should look like:
```ts
async function invokeAgent(
  node: GraphNode, state: RunState,
  precomputed?: { userPrompt: string; systemPrompt: string },
): Promise<AgentResult> {
  const def        = state.registry[node.agent!]
  const command    = state.overrides.provider ?? def.command
  const model      = state.overrides.model ?? def.model
  const userPrompt = precomputed?.userPrompt  ?? renderUserPrompt(sliceContext(state.context, node.slice), node.instruction)
  const sysPrompt  = precomputed?.systemPrompt ?? buildSystemPrompt(state.registry, node)
  const cwd        = resolve(state.context[`_worktree:${node.id}`] ?? node.cwd ?? process.cwd())
  const logFile    = state.storage.logPath(state.runDir, node.id)

  const agentTimeout = node.timeout ?? 600_000  // default 10 minutes

  const invoke = await loadProvider(command)
  const result = await Promise.race([
    invoke({ userPrompt, systemPrompt: sysPrompt, options: Object.keys(node.options ?? {}), cwd, model, logFile }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Agent timeout after ${agentTimeout}ms on node "${node.id}"`)), agentTimeout)),
  ])
  return result
}
```

- [ ] **Step 4: Remove tmux call from `run`**

In `run()` (~line 757), remove:
```ts
  tmux("new-window", "orch-log", `tail -f ${join(runDir, "orchestrator.log")}`)
```

- [ ] **Step 5: Remove `spawn` from imports if no longer used**

Check if `spawn` is still used elsewhere in core after removing tmux. `spawnSync` is used by `ensureTmux` (which will be removed in Task 4). If `spawn` and `spawnSync` are only used by tmux/ensureTmux code, remove them from the import on line 14:
```ts
// Before:
import { spawn, spawnSync }                                     from "child_process"
// After (if no other uses remain in steps 1-3):
// Remove entirely — will be cleaned up fully in Task 4
```

Keep `spawn`/`spawnSync` for now since `ensureTmux` still uses `spawnSync`. It will be removed in Task 4.

- [ ] **Step 6: Verify tmux panes still open/close**

Run a real workflow in tmux:
```bash
tmux new-session -s test
tsx supertinker.ts run --workflow meta --prompt "hello world test" --provider claude
```
Verify: orchestrator log pane opens on start, agent panes open/close per node.

- [ ] **Step 7: Commit**

```bash
git add hooks/tmux-panes.ts supertinker.ts
git commit -m "refactor: extract tmux pane management into hook

Move tmuxRunning(), tmux(), and all inline tmux calls from
supertinker.ts into hooks/tmux-panes.ts. The hook listens to
RunStart, PreProvider, and PostAgent events. Core no longer
has any tmux awareness."
```

---

### Task 2: Extract Template Validation into a Hook

**Files:**
- Create: `hooks/validate-templates.ts`
- Modify: `supertinker.ts:217-232` (delete `validateTemplateVariables`)
- Modify: `supertinker.ts:766` (delete call in `run`)

- [ ] **Step 1: Create `hooks/validate-templates.ts`**

```ts
import type { Hook, HookEvent, HookDirective, Workflow } from "../supertinker.js"

export const hook: Hook = {
  name: "validate-templates",
  description: "Aborts run if workflow instructions reference undefined template variables",
  events: ["RunStart"],
  parallel: false,
  priority: 0,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    const e = event as Extract<HookEvent, { event: "RunStart" }>
    const { graph } = e.workflow
    const initialContext = e.initialContext

    const nodeIds = new Set(graph.nodes.map(n => n.id))
    const unresolved: Array<{ nodeId: string; variable: string }> = []

    for (const node of graph.nodes) {
      if (!node.instruction) continue
      for (const match of node.instruction.matchAll(/\[(\w[\w-]*)\]/g)) {
        const variable = match[1]
        if (!nodeIds.has(variable) && !(variable in initialContext))
          unresolved.push({ nodeId: node.id, variable })
      }
    }

    if (unresolved.length > 0) {
      const details = unresolved.map(({ nodeId, variable }) => `  • [${variable}] in node "${nodeId}"`).join("\n")
      return {
        action: "abort",
        reason: `Workflow "${graph.id}" has unresolved template variables.\nAdd them to initialContext:\n${details}`,
      }
    }

    return { action: "continue" }
  },
}
```

- [ ] **Step 2: Remove `validateTemplateVariables` from `supertinker.ts`**

Delete the function (lines 217-232):
```ts
function validateTemplateVariables(graph: Graph, initialContext: Context): void {
  const nodeIds = new Set(graph.nodes.map(n => n.id))
  const unresolved: Array<{ nodeId: string; variable: string }> = []
  for (const node of graph.nodes) {
    if (!node.instruction) continue
    for (const match of node.instruction.matchAll(/\[(\w[\w-]*)\]/g)) {
      const variable = match[1]
      if (!nodeIds.has(variable) && !(variable in initialContext))
        unresolved.push({ nodeId: node.id, variable })
    }
  }
  if (unresolved.length > 0) {
    const details = unresolved.map(({ nodeId, variable }) => `  • [${variable}] in node "${nodeId}"`).join("\n")
    throw new Error(`Workflow "${graph.id}" has unresolved template variables.\nAdd them to initialContext:\n${details}`)
  }
}
```

- [ ] **Step 3: Remove call in `run()`**

In `run()` (~line 766), remove:
```ts
  validateTemplateVariables(graph, initialContext)
```

- [ ] **Step 4: Verify validation still catches bad templates**

Create a temporary test workflow with an undefined variable reference and confirm the run aborts with the expected error message:
```bash
tsx supertinker.ts run --workflow meta --prompt "test [undefined_var] reference"
```
The `abort` directive from the hook should produce an error containing "unresolved template variables".

- [ ] **Step 5: Commit**

```bash
git add hooks/validate-templates.ts supertinker.ts
git commit -m "refactor: extract template validation into RunStart hook

Move validateTemplateVariables() into hooks/validate-templates.ts.
The hook runs at priority 0 (sequential) so it fires before any
other RunStart hook. Returns abort directive on unresolved variables
instead of throwing."
```

---

### Task 3: Move Workflow Catalog to Storage Adapter

**Files:**
- Modify: `supertinker.ts:75-86` (add 2 methods to `StorageAdapter` interface)
- Modify: `supertinker.ts:88-123` (add implementations to `filesystemStorage`)
- Modify: `supertinker.ts:688-745` (delete/replace catalog functions)

- [ ] **Step 1: Add methods to `StorageAdapter` interface**

In `supertinker.ts`, add two methods to the `StorageAdapter` interface (after `logPath`):

```ts
export interface StorageAdapter {
  createRun(runId: string): Promise<string>
  saveContext(runDir: string, context: Context): Promise<void>
  loadContext(runDir: string): Promise<Context>
  savePause(runDir: string, state: PausedState): Promise<void>
  loadPause(runDir: string): Promise<PausedState>
  pauseExists(runDir: string): Promise<boolean>
  appendLog(runDir: string, line: string): Promise<void>
  saveFile(runDir: string, name: string, content: string): Promise<void>
  saveWorkflow(id: string, content: string): Promise<void>
  logPath(runDir: string, nodeId: string): string
  resolveWorkflow(name: string): Promise<string | null>
  listWorkflows(): Promise<Array<{ id: string; description: string; file: string; source: string }>>
}
```

- [ ] **Step 2: Implement in `filesystemStorage`**

Add the two methods to the `filesystemStorage` object:

```ts
  async resolveWorkflow(name) {
    const file = name.endsWith(".workflow.ts") ? name : `${name}.workflow.ts`
    for (const base of SEARCH_DIRS) {
      const p = join(base, "workflows", file)
      if (existsSync(p)) return p
    }
    return null
  },
  async listWorkflows() {
    const entries: Array<{ id: string; description: string; file: string; source: string }> = []
    const sources: Array<[string, string]> = [
      [join(PROJECT_DIR, "workflows"), "project"],
      [join(USER_DIR, "workflows"), "library"],
      [join(BUILTIN_DIR, "workflows"), "built-in"],
    ]
    for (const [dir, source] of sources) {
      let files: string[]
      try { files = readdirSync(dir).filter((f: string) => f.endsWith(".workflow.ts")) } catch { continue }
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), "utf8")
          const id   = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)?.[1] ?? file
          const description = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)?.[1] ?? "(no description)"
          entries.push({ id, description, file, source })
        } catch {}
      }
    }
    return entries
  },
```

- [ ] **Step 3: Replace `buildCatalog` with storage-delegating version**

Delete `catalogCache`, `catalogMtimeKey()`, and the old `buildCatalog()` body (lines 690-736). Replace with:

```ts
export async function buildCatalog(storage?: StorageAdapter): Promise<string> {
  const s = storage ?? await loadStorage()
  const entries = await s.listWorkflows()
  if (entries.length === 0) return "No workflows available."
  const lines = entries.map(e => `- ${e.id}: ${e.description} [${e.source}: ${e.file}]`)
  return `Available workflows (${entries.length}):\n${lines.join("\n")}`
}
```

Note: The old `buildCatalog` included `(${nodes} nodes)` counts. This required reading file contents and regex-matching node IDs — that logic now lives inside `listWorkflows()`. If node counts are desired in the catalog string, add a `nodeCount` field to the `listWorkflows` return type. Omitted here for simplicity since the count was approximate (regex-based) and not used by any consumer.

Note: `buildCatalog` signature changes from sync `(): string` to async `(storage?): Promise<string>`. This is fine because the only consumer (CLI) is already async.

- [ ] **Step 4: Delete `resolveWorkflow` function**

Delete the old `resolveWorkflow` (lines 738-745):
```ts
export function resolveWorkflow(name: string): string | null {
  const file = name.endsWith(".workflow.ts") ? name : `${name}.workflow.ts`
  for (const base of SEARCH_DIRS) {
    const p = join(base, "workflows", file)
    if (existsSync(p)) return p
  }
  return null
}
```

- [ ] **Step 5: Remove `statSync` from imports**

`statSync` was only used by `catalogMtimeKey`. Remove it from the `fs` import on line 13:
```ts
// Before:
import { appendFileSync, existsSync, mkdirSync, readdirSync,
         readFileSync, statSync, writeFileSync }                from "fs"
// After:
import { appendFileSync, existsSync, mkdirSync, readdirSync,
         readFileSync, writeFileSync }                          from "fs"
```

- [ ] **Step 6: Export `loadStorage`**

`loadStorage` needs to be exported so `cli.ts` (Task 4) and `buildCatalog` callers can use it:
```ts
// Before:
async function loadStorage(): Promise<StorageAdapter> {
// After:
export async function loadStorage(): Promise<StorageAdapter> {
```

- [ ] **Step 7: Update CLI callers (temporary — will be moved in Task 4)**

In `cli()`, update the `run` command to await `buildCatalog` and use `storage.resolveWorkflow`:
```ts
  if (cmd === "run") {
    const workflowRef  = get("--workflow") ?? "meta"
    const prompt       = get("--prompt")
    const provider     = get("--provider")
    const model        = get("--model")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    const storage = await loadStorage()
    const workflowPath = await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    const initialContext: Context = { catalog: await buildCatalog(storage), cwd: process.cwd() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext, overrides })
    return
  }
```

Update the `resume` command:
```ts
  if (cmd === "resume") {
    const runId = get("--run"), choice = get("--choice"), workflowRef = get("--workflow")
    const provider = get("--provider"), model = get("--model")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    if (!runId || !choice || !workflowRef) { console.error("Usage: supertinker resume --run <id> --choice <label> --workflow <name|path>"); process.exit(1) }
    const storage = await loadStorage()
    const { workflow } = await import(await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef))
    await resume({ workflow, runId, choice, overrides })
    return
  }
```

Update the `list` command:
```ts
    console.log(await buildCatalog())
```

- [ ] **Step 8: Verify workflow listing and resolution**

```bash
tsx supertinker.ts list
```
Should show all workflows from project, user, and built-in dirs.

```bash
tsx supertinker.ts run --workflow meta --prompt "test catalog" --provider claude
```
Should resolve meta workflow and inject catalog into context.

- [ ] **Step 9: Commit**

```bash
git add supertinker.ts
git commit -m "refactor: move workflow catalog to storage adapter

Add resolveWorkflow() and listWorkflows() to StorageAdapter interface.
The default filesystemStorage implements the same dir-scanning logic.
buildCatalog() becomes a thin async wrapper. Removes catalogCache,
catalogMtimeKey(), and the sync resolveWorkflow() from core.
Export loadStorage() for external consumers."
```

---

### Task 4: Extract CLI into `cli.ts`

**Files:**
- Create: `cli.ts`
- Modify: `supertinker.ts:793-937` (delete CLI, ensureTmux, entrypoint)
- Modify: `supertinker.ts:1-2` (remove shebang)
- Modify: `supertinker.ts:14` (remove `spawnSync` import)

- [ ] **Step 1: Create `cli.ts`**

```ts
#!/usr/bin/env tsx
/**
 * cli.ts — CLI entrypoint for supertinker
 *
 * Usage:
 *   tsx cli.ts run --prompt "Build a REST API"
 *   tsx cli.ts run --workflow meta --prompt "Build a REST API"
 *   tsx cli.ts resume --run <runId> --choice <label> --workflow <name|path>
 *   tsx cli.ts status --run <runId>
 *   tsx cli.ts list
 */

import { existsSync, mkdirSync, readFileSync }  from "fs"
import { spawnSync }                             from "child_process"
import { join, resolve }                         from "path"
import { run, resume, buildCatalog, loadStorage, loadHooks } from "./supertinker.js"
import type { Context, PausedState, ProviderOverrides }      from "./supertinker.js"

// ─── TMUX AUTO-LAUNCH

function ensureTmux(): boolean {
  if (!!process.env.TMUX) return true
  const args = process.argv.slice(1).map(a => `'${a}'`).join(" ")
  const sess = `supertinker-${Date.now()}`
  try {
    spawnSync("tmux", ["new-session", "-d", "-s", sess, `${process.argv[0]} ${args}`], { stdio: "ignore" })
    console.log(`supertinker running in tmux session: ${sess}`)
    console.log(`  attach:  tmux attach -t ${sess}`)
    console.log(`  kill:    tmux kill-session -t ${sess}`)
    return false
  } catch {
    console.log("(tmux not available — running without panes)")
    return true
  }
}

// ─── CLI

async function cli(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd  = argv[0]
  const get  = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

  if (cmd === "run") {
    const workflowRef  = get("--workflow") ?? "meta"
    const prompt       = get("--prompt")
    const provider     = get("--provider")
    const model        = get("--model")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    const storage = await loadStorage()
    const workflowPath = await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    const initialContext: Context = { catalog: await buildCatalog(storage), cwd: process.cwd() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext, overrides })
    return
  }

  if (cmd === "resume") {
    const runId = get("--run"), choice = get("--choice"), workflowRef = get("--workflow")
    const provider = get("--provider"), model = get("--model")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    if (!runId || !choice || !workflowRef) { console.error("Usage: supertinker resume --run <id> --choice <label> --workflow <name|path>"); process.exit(1) }
    const storage = await loadStorage()
    const { workflow } = await import(await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef))
    await resume({ workflow, runId, choice, overrides })
    return
  }

  if (cmd === "status") {
    const runId = get("--run")
    if (!runId) { console.error("Usage: supertinker status --run <runId>"); process.exit(1) }
    const storage = await loadStorage()
    const runDir = join("/tmp/orchestrator", runId)
    if (!existsSync(runDir)) { console.error(`Run directory not found: ${runDir}`); process.exit(1) }

    const hasPause = await storage.pauseExists(runDir)
    let hasContext = false
    try { await storage.loadContext(runDir); hasContext = true } catch {}

    console.log(`\n  Run: ${runId}`)
    console.log(`  Dir: ${runDir}`)
    console.log(`  Status: ${hasPause ? "PAUSED" : "completed"}\n`)

    if (hasPause) {
      const paused = await storage.loadPause(runDir)
      console.log(`  Paused at: ${paused.nodeId}`)
      if (paused.reason) console.log(`  Reason:    ${paused.reason}`)
      if (paused.iterationCounts) {
        const counts = Object.entries(paused.iterationCounts).filter(([, v]) => v > 0)
        if (counts.length > 0) console.log(`  Iterations: ${counts.map(([k, v]) => `${k}=${v}`).join(", ")}`)
      }
      console.log()
    }

    if (hasContext) {
      const ctx = await storage.loadContext(runDir)
      const keys = Object.keys(ctx)
      console.log(`  Context keys (${keys.length}):`)
      for (const key of keys) {
        const val = ctx[key]
        const preview = val.length > 120 ? val.slice(0, 120) + "..." : val
        console.log(`    [${key}] (${val.length} chars) ${preview.replace(/\n/g, " ")}`)
      }
      console.log()
    }

    const logPath = join(runDir, "orchestrator.log")
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").trim().split("\n")
      const tail = lines.slice(-10)
      console.log(`  Log (last ${tail.length} of ${lines.length} lines):`)
      for (const line of tail) console.log(`    ${line}`)
      console.log()
    }
    return
  }

  if (cmd === "list") {
    const flag = argv[1]
    if (flag === "--hooks") {
      const tmpDir = join("/tmp/orchestrator", "hook-list")
      mkdirSync(tmpDir, { recursive: true })
      const hooks = await loadHooks(tmpDir)
      const entries: string[] = []
      const seen = new Set<string>()
      for (const [, hookList] of hooks) {
        for (const h of hookList) {
          if (seen.has(h.name)) continue
          seen.add(h.name)
          entries.push(`- ${h.name}: ${h.description ?? "(no description)"}  events: [${h.events.join(", ")}]  parallel: ${h.parallel}  priority: ${h.priority}`)
        }
      }
      console.log(entries.length === 0 ? "No hooks found." : `Hooks (${entries.length}):\n${entries.join("\n")}`)
      return
    }
    console.log(await buildCatalog())
    return
  }

  console.log(`supertinker — minimal agent orchestrator

Commands:
  run     [--workflow <name|path>] --prompt <text>   (default: meta)
  resume  --run <runId> --choice <label> --workflow <name|path>
  status  --run <runId>   inspect a run's state and context
  list           show available workflows
  list --hooks   show discovered hooks

Examples:
  tsx cli.ts run --prompt "Build a REST API"
  tsx cli.ts run --workflow meta --prompt "Build a REST API"
  tsx cli.ts status --run meta-1234567890
  tsx cli.ts list`)
}

// ─── ENTRYPOINT

const cmd = process.argv[2]
if (!cmd || cmd === "list" || cmd === "status" || cmd === "help") cli().catch(err => { console.error(err); process.exit(1) })
else if (ensureTmux()) cli().catch(err => { console.error(err); process.exit(1) })
```

- [ ] **Step 2: Export `loadHooks` from `supertinker.ts`**

`loadHooks` is needed by the CLI `list --hooks` command:
```ts
// Before:
async function loadHooks(runDir: string): Promise<HookIndex> {
// After:
export async function loadHooks(runDir: string): Promise<HookIndex> {
```

- [ ] **Step 3: Delete CLI section from `supertinker.ts`**

Remove everything from `// ─── CLI` to end of file (lines 793-937):
- The `cli()` function
- The `// ─── TMUXAUTO-LAUNCH` section with `ensureTmux()`
- The `// ─── ENTRYPOINT` section with `isMain` check

- [ ] **Step 4: Remove shebang and update header comment**

```ts
// Before (line 1-10):
#!/usr/bin/env tsx
/**
 * supertinker.ts — A minimal agent orchestrator
 *
 * Usage:
 *   tsx supertinker.ts run --prompt "Build a REST API"
 *   tsx supertinker.ts run --workflow meta --prompt "Build a REST API"
 *   tsx supertinker.ts resume --run <runId> --choice <label> --workflow <name|path>
 *   tsx supertinker.ts list
 */

// After:
/**
 * supertinker.ts — A minimal agent orchestrator (library)
 *
 * Public API: run(), resume(), buildCatalog(), loadStorage(), loadHooks()
 * CLI entrypoint: see cli.ts
 */
```

- [ ] **Step 5: Clean up imports**

Remove `spawnSync` from the `child_process` import (no longer used in core after tmux and ensureTmux removal). Also remove `spawn` if it was kept from Task 1:
```ts
// Before:
import { spawn, spawnSync }                                     from "child_process"
// After: remove entire line (no child_process usage remains in core)
```

- [ ] **Step 6: Verify all CLI commands work via `cli.ts`**

```bash
tsx cli.ts list
tsx cli.ts list --hooks
tsx cli.ts status --run meta-1234567890  # use a real runId if available
tsx cli.ts run --workflow meta --prompt "hello world" --provider claude
tsx cli.ts resume --run <runId> --choice <label> --workflow meta  # if a paused run exists
```

- [ ] **Step 7: Commit**

```bash
git add cli.ts supertinker.ts
git commit -m "refactor: extract CLI into cli.ts

Move cli(), ensureTmux(), and entrypoint logic to cli.ts.
supertinker.ts is now a pure library exporting run(), resume(),
buildCatalog(), loadStorage(), and loadHooks(). No shebang,
no argv parsing, no child_process dependency."
```
