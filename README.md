<p align="center">
  <img src="https://em-content.zobj.net/source/apple/391/hammer-and-wrench_1f6e0-fe0f.png" width="120" />
</p>

<h1 align="center">supertinker</h1>

<p align="center">
  <strong>deterministic, resumable, multi-agent workflows in a single TypeScript file</strong>
</p>

<p align="center">
  <a href="https://github.com/AndurilCode/supertinker/stargazers"><img src="https://img.shields.io/github/stars/AndurilCode/supertinker?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/AndurilCode/supertinker/commits/main"><img src="https://img.shields.io/github/last-commit/AndurilCode/supertinker?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/AndurilCode/supertinker?style=flat" alt="License"></a>
  <img src="https://img.shields.io/badge/dependencies-zero-success" alt="Zero dependencies">
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#install">Install</a> •
  <a href="#usage">Usage</a> •
  <a href="#plugins">Plugins</a> •
  <a href="#writing-workflows">Workflows</a> •
  <a href="#architecture">Architecture</a>
</p>

---

Define **directed graphs** of AI agent calls — Claude Code, GitHub Copilot, or any custom provider. Each node invokes an agent, captures output into shared context, and follows an edge determined by the agent's own choice. The engine is a single TypeScript file with zero npm dependencies. Everything else — providers, hooks, workflows, storage — is a plugin you drop into a folder.

Runs anywhere Node.js runs: laptop, CI runner, dev container. No server, no database, no compile step.

## Features

- **Graph-based workflows** — DAGs with fan-out, fan-in, review loops, label-based branching
- **Multi-agent** — `claude` CLI, `copilot` CLI, or drop-in custom providers
- **Plugin system** — install, uninstall, update hooks/providers/workflows/storage via CLI
- **Meta-workflow** — an architect agent designs workflows at runtime, then executes them
- **Subworkflows** — embed one workflow inside another as a first-class node type
- **Fork / join** — fan out to N branches concurrently, synchronize at a join node
- **Git worktree isolation** — fork branches run in separate git worktrees for safe parallel edits
- **Pause & resume** — any node can pause for human input; resume with a choice label
- **Guardrails** — pre/post checks (JS expressions or TypeScript functions); retry once, then pause
- **Template validation** — pre-flight check that `[nodeId]` references in instructions point to real nodes
- **Context slicing** — nodes declare which context keys the agent sees, keeping token budgets predictable
- **Structured logging** — human-readable `orchestrator.log` + machine-readable NDJSON event stream
- **Tmux integration** — auto-spawns panes to tail orchestrator and per-agent logs
- **Zero dependencies** — only Node.js built-ins: `fs`, `child_process`, `path`, `os`

## Install

### As a skill (recommended)

Install the supertinker skill into your AI agent with [skills](https://skills.sh):

```bash
npx skills add AndurilCode/supertinker
```

Once installed, your agent can invoke supertinker through the `/supertinker` command or naturally when you ask it to orchestrate multi-agent workflows.

### Standalone

```bash
npx github:AndurilCode/supertinker run --prompt "Build a REST API with authentication"
```

Or clone for development:

```bash
git clone https://github.com/AndurilCode/supertinker.git
cd supertinker
tsx cli.ts run --prompt "Build a REST API with authentication"
```

### Prerequisites

- **Node.js** v18+
- A TypeScript runner — **bun** (fastest), **tsx** (`npm i -g tsx`), or **Node.js ≥ 22.6** (built-in `--experimental-strip-types`)
- At least one agent CLI in `$PATH`: [`claude`](https://docs.anthropic.com/en/docs/claude-code) (required), `copilot` (optional plugin)

## Usage

### Run a workflow

```bash
# Meta-workflow — an architect designs the right workflow for your task
npx github:AndurilCode/supertinker run --prompt "Migrate the schema to add soft deletes"

# Named workflow
npx github:AndurilCode/supertinker run --workflow plan-develop-review --prompt "Add user auth"

# Workflow file by path
npx github:AndurilCode/supertinker run --workflow ./my-workflow.ts --prompt "Refactor the data layer"
```

### Resume a paused run

```bash
npx github:AndurilCode/supertinker resume \
  --run meta-generate-and-run-<timestamp> \
  --choice approved \
  --workflow meta
```

### Other commands

```bash
npx github:AndurilCode/supertinker status --run <runId>     # check run status
npx github:AndurilCode/supertinker list                     # list available workflows
npx github:AndurilCode/supertinker list --hooks              # list loaded hooks + events
```

## Plugins

Plugins are the primary extension mechanism. Each lives in `plugins/<type>/<name>/` with a `manifest.json`.

### Available plugins

| Name | Type | Description |
|------|------|-------------|
| **logger** | hook | Structured logging to `orchestrator.log` and stdout |
| **events** | hook | NDJSON event stream to `events.ndjson` for machine-readable audit |
| **fork-worktree** | hook | Git worktree isolation for parallel fork branches |
| **tmux-panes** | hook | Opens tmux panes for orchestrator and per-agent log tailing |
| **validate-templates** | hook | Aborts run if instructions reference undefined `[nodeId]` variables |
| **copilot** | provider | GitHub Copilot CLI provider with sentinel-based choice parsing |
| **meta** | workflow | Architect agent designs a workflow, then the orchestrator executes it |
| **custom** | storage | Project-local workflow persistence to `.supertinker/workflows/` |

### Manage plugins

```bash
npx github:AndurilCode/supertinker plugins list                     # all available
npx github:AndurilCode/supertinker plugins list --installed          # installed only
npx github:AndurilCode/supertinker plugins install                   # interactive picker
npx github:AndurilCode/supertinker plugins install logger events     # install by name
npx github:AndurilCode/supertinker plugins install --global          # install to ~/.supertinker/
npx github:AndurilCode/supertinker plugins uninstall copilot --local
npx github:AndurilCode/supertinker plugins update                    # sync to latest
```

### Plugin search order

Plugins are discovered in three locations, **project-local first**:

| Priority | Location | Scope |
|----------|----------|-------|
| 1 | `.supertinker/` | Per-project (highest) |
| 2 | `~/.supertinker/` | Per-user |
| 3 | `<install-dir>/` | Built-in (lowest) |

Providers and workflows **override** by name (first match wins). Hooks **merge** (all hooks from all locations run). Storage adapters merge (custom methods override defaults).

<details>
<summary><strong>Writing a plugin</strong></summary>

Create a directory under `plugins/<type>/<name>/` with a `manifest.json`:

```json
{
  "name": "my-hook",
  "type": "hook",
  "description": "What it does",
  "files": ["my-hook.ts"],
  "version": "1.0.0"
}
```

Place implementation files alongside the manifest. Users install with `plugins install my-hook`.

</details>

## Writing workflows

Workflows are plain TypeScript objects implementing the `Workflow` interface from `supertinker.ts`.

```typescript
import type { Workflow, GuardrailCheck } from "../supertinker"

const planHasStructure: GuardrailCheck = ({ nodeId, output }) => {
  if (nodeId !== "plan" || !output) return { pass: true }
  if (!output.includes("## Steps")) return { pass: false, reason: "Plan missing '## Steps' section" }
  return { pass: true }
}

export const workflow: Workflow = {
  id: "plan-develop-review",
  description: "Plan, implement, and review a TypeScript feature",
  guardrails: { post: [planHasStructure], maxIterations: 3 },

  registry: {
    planner:     { command: "claude", model: "sonnet", systemPrompt: "You are a planning agent..." },
    claude_code: { command: "claude", model: "sonnet", systemPrompt: "You are a TypeScript engineer..." },
    reviewer:    { command: "copilot",                 systemPrompt: "You are a code reviewer..." },
  },

  graph: {
    id: "plan-develop-review",
    start: "plan",
    fallback: "human_review",
    labels: ["done", "approved", "needs_work", "needs_clarify"],
    nodes: [
      { id: "plan", agent: "planner",
        instruction: "Produce a detailed implementation plan",
        options: { done: "develop", needs_clarify: "human_review" } },
      { id: "develop", agent: "claude_code", slice: ["task", "plan"],
        instruction: "Implement the plan described in [plan]",
        options: { done: "review", needs_clarify: "human_review" } },
      { id: "review", agent: "reviewer", slice: ["task", "plan", "develop"],
        instruction: "Review [develop] against [plan]",
        options: { approved: "complete", needs_work: "develop" } },
      { id: "complete",     type: "done" },
      { id: "human_review", type: "paused" },
    ],
  },
}
```

### Node types

| Type | Description |
|------|-------------|
| *(standard)* | Runs an agent. Requires `agent`, `instruction`, `options`. |
| `"fork"` | Fans out to `targets[]` concurrently. No agent. |
| `"join"` | Waits for all `waits_for[]` branches, then optionally runs an agent. |
| `"subworkflow"` | Parses a workflow from `context[source]` and executes it. |
| `"done"` | Terminal — success. |
| `"paused"` | Terminal — paused, awaiting human input. |
| `"failed"` | Terminal — unrecoverable failure. |

### Context references

Use `[nodeId]` in an instruction to inject a prior node's output:

```
"Review the code in [develop] against the plan in [plan]"
```

<details>
<summary><strong>Guardrails</strong></summary>

Pre- and post-execution checks. Failing post-guardrails retry once (with failure reason injected), then pause. Failing pre-guardrails pause immediately.

```typescript
guardrails: {
  maxIterations: 3,
  pre:  [{ check: "context.task?.length > 0", reason: "Task is empty" }],
  post: [
    { check: "output.trim().length > 0",                          reason: "Empty output" },
    { check: "output.length < 10000",                             reason: "Output too long" },
    { check: "!/(sk-|ghp_|AKIA)[A-Za-z0-9]{10,}/.test(output)", reason: "Contains API key" },
  ],
}
```

Variables available: `output`, `choice`, `nodeId`, `context`, `require` (CJS require).

</details>

<details>
<summary><strong>Writing a hook</strong></summary>

Place a `.ts` or `.js` file in `.supertinker/hooks/` (project-local) or `~/.supertinker/hooks/` (global). Export a `Hook` object:

```typescript
import type { Hook } from "../supertinker"

export const hook: Hook = {
  name: "block-on-test-failure",
  events: ["PostAgent"],
  priority: 50,
  handler: async (event) => {
    const e = event as Extract<typeof event, { event: "PostAgent" }>
    if (e.nodeId === "test" && e.result.choice !== "passed")
      return { action: "pause", reason: "Tests did not pass" }
    return { action: "continue" }
  },
}
```

**Directives:** `continue` (all events) · `skip` (PreAgent, PreProvider) · `pause` (PreAgent, PreProvider, PostAgent, GuardrailFail, SubworkflowStart) · `redirect` (PreAgent, PreProvider, PostAgent) · `abort` (all events)

When multiple hooks fire, highest-rank wins: `abort > pause > redirect > skip > continue`.

**Events:** `RunStart` · `RunEnd` · `PreAgent` · `PreProvider` · `PostAgent` · `Paused` · `Resumed` · `ForkStart` · `ForkJoin` · `GuardrailFail` · `SubworkflowStart` · `SubworkflowEnd` · `Error`

</details>

<details>
<summary><strong>Writing a custom provider</strong></summary>

Place a `.ts` or `.js` file in `.supertinker/providers/` or `~/.supertinker/providers/`. Export an `invoke` function:

```typescript
export async function invoke(ctx: {
  userPrompt: string; systemPrompt: string; options: string[]
  cwd: string; model?: string; logFile: string
}): Promise<{ output: string; choice: string; transcriptPath?: string }> {
  // Spawn your agent CLI, capture output, return output + one of ctx.options
}
```

Loaded lazily by name from the registry's `command` field. `command: "my-provider"` loads `providers/my-provider.ts`.

</details>

<details>
<summary><strong>Writing a storage adapter</strong></summary>

Place `storage.ts` in `.supertinker/storage/` or `~/.supertinker/storage/`. Export a partial `StorageAdapter` — only override what you need:

```typescript
import type { StorageAdapter } from "../../supertinker.js"

export const storage: Partial<StorageAdapter> = {
  async saveWorkflow(id, content) {
    // custom persistence logic
  },
}
```

**Methods:** `createRun` · `saveContext` · `loadContext` · `savePause` · `loadPause` · `pauseExists` · `appendLog` · `saveFile` · `saveWorkflow` · `logPath`

</details>

## Architecture

```
                         ┌──────────────────────────────┐
  CLI                    │           cli.ts              │
  ──────────────────────▶│  run, resume, status, list,   │
                         │  plugins install/uninstall    │
                         └──────────────┬───────────────┘
                                        │ calls
                         ┌──────────────▼───────────────┐
                         │       supertinker.ts          │
                         │  run() / resume() / catalog   │
                         └──────────────┬───────────────┘
                                        │ loads
               ┌────────────────────┬───┼────────────────────┐
               ▼                    ▼   ▼                    ▼
        Storage adapter      Workflow  Hook index       Provider registry
        ───────────────      ────────  ──────────       ─────────────────
        filesystem (default) DAG       13 events        claude (built-in)
        DB / S3 / custom     Guardrails priority order  copilot (plugin)
                                       parallel/serial  custom providers

                                        │
                                        ▼
                              ┌─────────────────┐
                              │  Node execution  │
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

### Execution model

1. `run()` loads the storage adapter, creates a run directory at `/tmp/orchestrator/<workflowId>-<timestamp>/`
2. Hooks discovered from all three search paths (project, user, built-in)
3. Tmux panes opened for log tailing (when in a tmux session)
4. Graph starts at `graph.start`. For each standard node:
   - Pre-guardrails → `PreAgent` hook → context slicing → `PreProvider` hook → provider CLI spawn → `PostAgent` hook → post-guardrails → follow edge
5. Fork nodes fan out concurrently; join nodes block until all branches complete
6. Subworkflow nodes parse a JSON workflow from context, write to disk, execute as nested `run()`
7. Terminal nodes (`done`, `paused`, `failed`) end the run

### Run artifacts

Each run creates a directory at `/tmp/orchestrator/<workflowId>-<timestamp>/`:

| File | Contents |
|------|----------|
| `orchestrator.log` | Structured timestamped log of all lifecycle events |
| `events.ndjson` | Machine-readable NDJSON event stream (when `events` hook installed) |
| `context.json` | Final key-value context (all node outputs) |
| `state.json` | Paused-run state: runId, nodeId, context, agent output, pause reason |
| `<nodeId>.log` | Raw provider output for each executed node |
| `<workflowId>.workflow.ts` | Materialised workflow file (subworkflow runs only) |

## Contributing

The core engine lives in a single file (`supertinker.ts`). **New features should be plugins, not core expansions.**

- Additional provider plugins (Gemini CLI, OpenAI CLI, local models via `ollama`)
- Additional workflow plugins (TDD, documentation generation, security review)
- Additional hook plugins (Slack notifications, cost tracking, rate limiting)
- Custom storage adapter plugins (database-backed, S3, distributed)

Please open an issue before submitting a large pull request.

## License

MIT
