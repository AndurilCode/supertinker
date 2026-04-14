# supertinker

**A zero-dependency TypeScript agent orchestrator for composing deterministic, resumable, multi-agent workflows.**

[![Node.js ≥18](https://img.shields.io/badge/node-%3E%3D18-brightgreen?logo=node.js)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-blue?logo=typescript)](https://www.typescriptlang.org)
[![Zero dependencies](https://img.shields.io/badge/dependencies-zero-success)](https://github.com/nickvdyck/supertinker/blob/main/supertinker.ts)

---

## Overview

supertinker lets you define **directed acyclic graphs (DAGs)** of AI agent calls. Each node invokes an agent — Claude Code, GitHub Copilot, or any custom provider — captures its output into a shared context, and follows an edge determined by the agent's own output choice. The engine ships as a single TypeScript file with no npm runtime dependencies. Extensions are plugins: providers, hooks, storage adapters, and workflows — the core stays thin.

**Why supertinker?**

Most orchestration frameworks require a server, a database, or a runtime you don't control. supertinker runs anywhere Node.js runs: a laptop, a CI runner, a dev container. Workflows are plain TypeScript objects. Hooks and providers are modules you drop into a folder. Nothing needs compiling; `tsx` executes everything directly.

---

## Features

| Category | Detail |
|---|---|
| **Graph-based workflows** | DAGs with fan-out, fan-in, review loops, and label-based branching |
| **Multi-agent support** | `claude` CLI, `copilot` CLI, or drop-in custom providers |
| **Meta-workflow** | An architect agent designs new workflows at runtime; the engine executes them |
| **Subworkflows** | Embed one workflow inside another as a first-class node type |
| **Fork / join parallelism** | Fan out to N independent branches, synchronize at a join node |
| **Pause & resume** | Any node can pause execution for a human decision; resume with a choice label |
| **Guardrails** | Pre- and post-execution checks (JS expressions or TypeScript functions); failures retry once, then pause |
| **Iteration limits** | `maxIterations` prevents infinite review loops |
| **Storage adapter** | Pluggable persistence layer — swap filesystem for DB, S3, or custom backends |
| **Hook system** | 13 lifecycle events; hooks can observe, mutate context, skip / redirect / pause / abort |
| **Context threading** | Each node's output is stored as `context[nodeId]`; downstream nodes reference it via `[nodeId]` in instructions |
| **Context slicing** | Nodes declare a `slice` list to limit what context the agent sees, reducing token use |
| **Built-in logger** | Structured log to `<runDir>/orchestrator.log` and stdout for every lifecycle event |
| **Tmux integration** | Auto-spawns a tmux window to tail the orchestrator log |
| **No dependencies** | Only Node.js built-ins: `fs`, `child_process`, `path`, `os`, `crypto` |

---

## Project structure

```
supertinker/
├── supertinker.ts              # Core engine + CLI
├── providers/
│   ├── claude.ts               # Claude Code CLI provider
│   └── copilot.ts              # GitHub Copilot CLI provider
├── workflows/
│   └── meta.workflow.ts        # Meta-workflow: architect designs + executes workflows
├── hooks/
│   └── logger.ts               # Built-in structured logger hook
└── examples/
    └── workflow.ts             # Example: plan → develop → review loop
```

### Plugin search order

Plugins are discovered in three locations, **project-local first**:

```
.supertinker/          ← per-project (highest priority)
~/.supertinker/        ← per-user
<install-dir>/         ← built-in (lowest priority)
```

Each location can contain:

```
├── providers/      # Provider modules (*.ts or *.js)
├── hooks/          # Hook modules (*.ts or *.js)
├── workflows/      # Workflow modules (*.workflow.ts)
└── storage/        # Storage adapter (storage.ts or storage.js)
```

Providers and workflows **override** by name (first match wins). Hooks **merge** (all hooks from all locations run together). Storage adapters merge (custom methods override defaults, unset methods fall back to filesystem).

---

## Prerequisites

- **Node.js** v18+
- **`tsx`** — TypeScript executor (no compile step needed)

  ```bash
  npm install -g tsx
  # or prefix any command with: npx tsx supertinker.ts ...
  ```

- At least one agent CLI available in `$PATH`:
  - [`claude`](https://docs.anthropic.com/en/docs/claude-code) — Claude Code CLI
  - `copilot` — GitHub Copilot CLI (optional)

No `npm install` is needed. The project has zero npm runtime dependencies.

---

## Usage

### Run a workflow

```bash
# Use the built-in meta-workflow (an architect agent designs a workflow, then runs it)
tsx supertinker.ts run --prompt "Build a REST API with authentication"

# Use a named built-in workflow
tsx supertinker.ts run --workflow plan-develop-review --prompt "Add user authentication"

# Use a workflow file by path
tsx supertinker.ts run --workflow ./my-workflow.ts --prompt "Refactor the data layer"
```

### Resume a paused run

Workflows pause when a `paused` terminal node is reached — on a guardrail failure, a human-review node, or an agent error. The logger prints the exact resume command:

```bash
tsx supertinker.ts resume \
  --run meta-generate-and-run-<timestamp> \
  --choice approved \
  --workflow meta
```

### Discover available workflows and hooks

```bash
tsx supertinker.ts list           # list available workflows
tsx supertinker.ts list --hooks   # list loaded hooks and their subscribed events
```

---

## Execution model

1. `run()` loads the storage adapter and creates a run directory (default: `/tmp/orchestrator/<workflowId>-<timestamp>/`).
2. Hooks are discovered from all three search paths (project, user, built-in).
3. A tmux window is opened to tail `orchestrator.log` (when in a tmux session).
4. The graph starts at `graph.start`. For each standard node:
   - Pre-guardrails run; `PreAgent` hook fires (can skip, redirect, pause, or abort).
   - Context is sliced, prompts are rendered.
   - `PreProvider` hook fires (can intercept before CLI spawn — useful for logging, rate limiting, dry-run).
   - The provider CLI is spawned and output is captured.
   - `PostAgent` hook fires; post-guardrail checks run (retry once on failure, then pause).
   - The graph follows the edge matching the agent's chosen label.
5. Fork nodes fan out to branches concurrently; join nodes block until all listed branches complete.
6. Subworkflow nodes parse a JSON workflow from context, write it to disk, and execute it as a nested `run()`.
7. Terminal nodes (`done`, `paused`, `failed`) end the run; `context.json` and `state.json` are written to the run directory.

---

## Architecture overview

```
                         ┌─────────────────────────────┐
  CLI args               │         supertinker.ts       │
  ──────────────────────▶│  run() / resume() / list()   │
                         └──────────────┬──────────────┘
                                        │ loads
               ┌────────────────────┬───┼────────────────────┐
               ▼                    ▼   ▼                    ▼
        Storage adapter      Workflow  Hook index       Provider registry
        ───────────────      ────────  ──────────       ─────────────────
        filesystem (default) DAG       13 events        claude.ts
        DB / S3 / custom     Guardrails priority order  copilot.ts
                                       parallel/serial  custom providers

                                        │
                                        ▼
                              ┌─────────────────┐
                              │  Node execution  │
                              │                  │
                              │  1. Slice ctx    │
                              │  2. Render prompt│
                              │  3. Spawn CLI    │
                              │  4. Guardrails   │
                              │  5. Fire hooks   │
                              │  6. Follow edge  │
                              └────────┬─────────┘
                                       │
                         ┌─────────────┴─────────────┐
                         ▼                           ▼
                    Fork / Join                 Subworkflow
                    (concurrent)               (recursive run)
```

**Data flow**: Every node's output is stored in a shared `Context` map (`context[nodeId]`). Downstream nodes reference prior outputs via `[nodeId]` placeholders in their instructions. The `slice` field limits which context keys are forwarded to the provider, keeping token budgets predictable.

---

## Writing a workflow

Workflows are plain TypeScript objects that implement the `Workflow` interface exported from `supertinker.ts`.

```typescript
import type { Workflow, GuardrailCheck } from "../supertinker"

const planHasStructure: GuardrailCheck = ({ nodeId, output }) => {
  if (nodeId !== "plan" || !output) return { pass: true }
  if (!output.includes("## Steps")) return { pass: false, reason: "Plan missing '## Steps' section" }
  if (!output.includes("## Files")) return { pass: false, reason: "Plan missing '## Files' section" }
  return { pass: true }
}

export const workflow: Workflow = {
  id: "plan-develop-review",
  description: "Plan, implement, and review a TypeScript feature",

  guardrails: {
    post: [planHasStructure],
    maxIterations: 3,
  },

  registry: {
    planner:     { command: "claude",  model: "sonnet", systemPrompt: "You are a planning agent..." },
    claude_code: { command: "claude",  model: "sonnet", systemPrompt: "You are a TypeScript engineer..." },
    reviewer:    { command: "copilot",                  systemPrompt: "You are a code reviewer..." },
  },

  graph: {
    id: "plan-develop-review",
    start: "plan",
    fallback: "human_review",
    labels: ["done", "approved", "needs_work", "needs_clarify"],

    nodes: [
      {
        id: "plan", agent: "planner",
        instruction: "Produce a detailed implementation plan",
        options: { done: "develop", needs_clarify: "human_review" }
      },
      {
        id: "develop", agent: "claude_code",
        slice: ["task", "plan"],
        instruction: "Implement the plan described in [plan]",
        options: { done: "review", needs_clarify: "human_review" }
      },
      {
        id: "review", agent: "reviewer",
        slice: ["task", "plan", "develop"],
        instruction: "Review [develop] against [plan]",
        options: { approved: "complete", needs_work: "develop" }  // loop back on needs_work
      },
      { id: "complete",     type: "done"   },
      { id: "human_review", type: "paused" }
    ]
  }
}
```

### Node types

| Type | Description |
|---|---|
| *(standard)* | Runs an agent. Requires `agent`, `instruction`, `options`. |
| `"fork"` | Fans out to `targets[]` concurrently. No agent. |
| `"join"` | Waits for all `waits_for[]` branches, then optionally runs an agent. |
| `"subworkflow"` | Parses a workflow from `context[source]` and executes it. Accepts optional `slice` and `cwd`. |
| `"done"` | Terminal — success. |
| `"paused"` | Terminal — paused, awaiting human input. |
| `"failed"` | Terminal — unrecoverable failure. |

### Context references

Use `[nodeId]` in an instruction to inject a prior node's output at runtime:

```
"Review the code in [develop] against the plan in [plan]"
```

---

## Guardrails

Guardrails run mechanical checks before or after each agent invocation. A failing post-guardrail retries the agent once (with the failure reason injected), then pauses the run. A failing pre-guardrail pauses immediately.

```typescript
guardrails: {
  maxIterations: 3,
  pre: [
    { check: "context.task?.length > 0", reason: "Task is empty" }
  ],
  post: [
    { check: "output.trim().length > 0",                          reason: "Empty output" },
    { check: "output.length < 10000",                             reason: "Output too long" },
    { check: "!/(sk-|ghp_|AKIA)[A-Za-z0-9]{10,}/.test(output)", reason: "Contains API key" }
  ]
}
```

Variables available in rule expressions: `output`, `choice`, `nodeId`, `context`, `require` (CJS require for filesystem checks).

Guardrail checks can also be TypeScript functions (`GuardrailCheck`) for logic that JS expressions cannot express cleanly — see `examples/workflow.ts`.

---

## Writing a hook

Place a `.ts` or `.js` file in `~/.supertinker/hooks/` (or `hooks/` alongside `supertinker.ts`). Export a `Hook` object:

```typescript
import type { Hook } from "../supertinker"

export const hook: Hook = {
  name: "block-on-test-failure",
  description: "Pause the run if the test node does not report passing tests",
  events: ["PostAgent"],
  parallel: true,   // run concurrently with other hooks (default: true)
  priority: 50,     // 0 = highest priority (default: 50)
  timeout: 30_000,  // ms (default: 30 000)

  handler: async (event) => {
    const e = event as Extract<typeof event, { event: "PostAgent" }>
    if (e.nodeId === "test" && e.result.choice !== "passed") {
      return { action: "pause", reason: "Tests did not pass" }
    }
    return { action: "continue" }
  },
}
```

### Hook directives

| Directive | Supported on |
|---|---|
| `{ action: "continue" }` | All events |
| `{ action: "skip" }` | `PreAgent`, `PreProvider` |
| `{ action: "pause", reason }` | `PreAgent`, `PreProvider`, `PostAgent`, `GuardrailFail`, `SubworkflowStart` |
| `{ action: "redirect", targetNodeId }` | `PreAgent`, `PreProvider`, `PostAgent` |
| `{ action: "abort", reason }` | All events |

When multiple hooks fire for the same event, the highest-rank directive wins: `abort > pause > redirect > skip > continue`.

### Lifecycle events

`RunStart` · `RunEnd` · `PreAgent` · `PreProvider` · `PostAgent` · `Paused` · `Resumed` · `ForkStart` · `ForkJoin` · `GuardrailFail` · `SubworkflowStart` · `SubworkflowEnd` · `Error`

All agent-related events (`PreAgent`, `PreProvider`, `PostAgent`) include a `provider` field with the CLI command name (e.g. `"claude"`, `"copilot"`).

---

## Writing a custom provider

Place a `.ts` or `.js` file in `~/.supertinker/providers/` (or `providers/`). Export an `invoke` function:

```typescript
export async function invoke(ctx: {
  userPrompt:   string
  systemPrompt: string
  options:      string[]      // valid choice labels
  cwd:          string
  model?:       string
  logFile:      string
}): Promise<{ output: string; choice: string; transcriptPath?: string }> {
  // Spawn your agent CLI, capture its output, return output + one of ctx.options
}
```

Providers are loaded lazily by name from the registry's `command` field. For example, `command: "my-provider"` loads `providers/my-provider.ts`.

---

## Writing a storage adapter

Place a `storage.ts` (or `.js`) file in `.supertinker/storage/` or `~/.supertinker/storage/`. Export a partial `StorageAdapter` object — only override the methods you need:

```typescript
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { StorageAdapter } from "../../supertinker.js"

export const storage: Partial<StorageAdapter> = {
  async saveWorkflow(id, content) {
    const dir = join(process.cwd(), ".supertinker", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.workflow.ts`), content)
  },
}
```

### StorageAdapter methods

| Method | Default behavior |
|---|---|
| `createRun(runId)` | Creates `/tmp/orchestrator/<runId>/` |
| `saveContext(runDir, context)` | Writes `context.json` |
| `loadContext(runDir)` | Reads `context.json` |
| `savePause(runDir, state)` | Writes `state.json` |
| `loadPause(runDir)` | Reads `state.json` |
| `pauseExists(runDir)` | Checks `state.json` exists |
| `appendLog(runDir, line)` | Appends to `orchestrator.log` |
| `saveFile(runDir, name, content)` | Writes file to run directory |
| `saveWorkflow(id, content)` | Saves to `~/.supertinker/workflows/` |
| `logPath(runDir, nodeId)` | Returns `<runDir>/<nodeId>.log` |

---

## Meta-workflow

The built-in `meta` workflow (`workflows/meta.workflow.ts`) is the recommended entry point for open-ended tasks. It runs in two stages:

1. **`design` node** — An architect agent reads a workflow catalog, inspects the working directory for existing artifacts, and designs (or reuses) a `Workflow` JSON object tailored to the task. Post-guardrails verify the output is valid `Workflow` JSON before proceeding.
2. **`execute` node** — A `subworkflow` node parses the JSON, materialises it to disk, saves it to the workflow library (via the storage adapter), and executes it as a nested run.

`maxIterations: 3` on the design node prevents infinite retry loops if the architect produces malformed JSON.

```bash
# Let the meta-workflow decide how to approach your task
tsx supertinker.ts run --prompt "Migrate the database schema to add soft deletes"
```

---

## Run artifacts

Each run creates a directory at `/tmp/orchestrator/<workflowId>-<timestamp>/`:

| File | Contents |
|---|---|
| `orchestrator.log` | Structured timestamped log of all lifecycle events |
| `context.json` | Final key-value context (all node outputs) |
| `state.json` | Paused-run state: `runId`, `nodeId`, context, agent output, pause reason |
| `<nodeId>.log` | Raw provider output for each executed node |
| `<workflowId>.workflow.ts` | Materialised workflow file (subworkflow runs only) |

---

## Configuration

### Claude Code permissions (`.claude/settings.local.json`)

If you run supertinker inside a Claude Code session, add these permissions so Claude can observe run artifacts:

```json
{
  "permissions": {
    "allow": [
      "Read(/tmp/orchestrator/**)",
      "Bash(tmux capture-pane:*)",
      "Bash(npx tsx:*)"
    ]
  }
}
```

### Guardrail rule variables reference

| Variable | Type | Available in |
|---|---|---|
| `output` | `string` | Post-guardrails |
| `choice` | `string` | Post-guardrails |
| `nodeId` | `string` | Pre- and post-guardrails |
| `context` | `Record<string, string>` | Pre- and post-guardrails |

---

## Contributing

Contributions are welcome. The core engine lives in a single file (`supertinker.ts`) — read it end-to-end before making changes. **New features should be implemented as plugins (providers, hooks, storage adapters, workflows), not by expanding the core.**

**Areas open for contribution:**
- Additional providers (Gemini CLI, OpenAI CLI, local models via `ollama`)
- Additional workflows (test-driven development, documentation generation, security review)
- Additional hooks (Slack notifications, cost tracking, audit logging, rate limiting)
- Custom storage adapters (database-backed, S3, distributed)

Please open an issue before submitting a large pull request so the approach can be discussed first.

---

## License

MIT
