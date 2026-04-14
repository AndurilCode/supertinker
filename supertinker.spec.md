# Supertinker: A Minimal Agent Orchestrator

**Status**: Draft  
**Date**: April 2026

---

## TL;DR

Supertinker is a TypeScript orchestrator that executes complex multi-agent workflows by interpreting a typed graph definition. All intelligence lives in the agents and the graph — the runtime is a ~80-line FSM loop with no domain knowledge, no state beyond graph traversal, and no opinion about what the agents do internally.

---

## Background

CLI-based coding agents (Claude Code, GitHub Copilot CLI) support non-interactive headless mode — they accept a prompt, execute autonomously, and write output to stdout. Composing these agents into complex workflows currently requires either hand-written shell scripts (brittle, no structure) or heavyweight orchestration frameworks (too opinionated, too thick).

The gap is a minimal, typed, inspectable runtime that can compose agents into arbitrarily complex workflows without becoming a framework.

---

## Goals and Non-Goals

### Goals
- Execute a human-authored agent workflow graph with no runtime intelligence
- Support sequential, conditional, parallel, and looping execution patterns
- Display each agent's activity visually in a tmux pane
- Allow human review and graph patching when an agent produces unexpected output
- Export a clean TypeScript API so graph and registry are authored as typed objects

### Non-Goals
- Dynamic graph generation at runtime (agents may emit subtasks internally — the orchestrator never sees them)
- Graph validation (authoring errors surface at runtime, not at load time)
- Multi-machine or distributed execution
- Agent authentication or credential management

---

## Design

### Core Principle

The orchestrator is a **runtime, not a brain**. It traverses a graph, invokes agents, and threads context forward. Every decision — what to do, what to produce, which path to take — is made either by the agent or by the graph author. The orchestrator executes what is already decided.

Thickness in an orchestrator = intelligence that doesn't belong there.

---

### Primitives

**Structural**

| Primitive | Description |
|-----------|-------------|
| `Node` | Unit of work: agent invocation + context spec + declared options |
| `Edge` | Labeled connection between nodes; carries the agent's choice |
| `Fork` | Fans out to N parallel nodes simultaneously; no agent |
| `Join` | Unblocks when all declared predecessors complete |

**Context**

| Primitive | Description |
|-----------|-------------|
| `Append` | Node output is written to shared context, keyed by node id (default) |
| `Slice` | Node receives only a declared subset of context keys |

**Terminal**

| Primitive | Description |
|-----------|-------------|
| `Done` | Graph completed successfully |
| `Failed` | Hard stop, surface error |
| `Paused` | Human review required; execution halts until resumed |

Loops need no special primitive — an edge may point to any earlier node id. The orchestrator follows edges regardless of direction.

---

### Graph Format

The graph is a native TypeScript object. No serialization format, no parser, no schema validator. The TypeScript compiler is the validation layer.

```typescript
type Graph = {
  id: string
  start: string                  // entry node id
  fallback: string               // global fallback node id (Paused)
  labels: string[]               // declared choice vocabulary (documentation)
  nodes: Node[]
}

type Node = {
  id: string
  type?: "fork" | "join" | "done" | "failed" | "paused"

  // Standard node fields
  agent?: string                 // agent id from registry
  cwd?: string                   // working directory (default: orchestrator cwd)
  slice?: string[]               // context keys to pass (default: all)
  instruction?: string           // prepended to user prompt — semantic handoff
  systemPrompt?: string          // node-level system prompt override
  options?: Record<string, string>  // { label → next node id }
  fallback?: string              // local fallback override

  // Fork fields
  targets?: string[]             // node ids to spawn in parallel

  // Join fields
  waits_for?: string[]           // node ids that must complete before unblocking
}
```

**Labels vocabulary**: declared at graph level for documentation purposes. Not enforced at runtime. Tells the graph author the full set of valid choice labels at a glance.

**Options shorthand**: the key is what the agent outputs; the value is where execution goes next. No separate edge list needed.

---

### Agent Contract

Every agent, regardless of the underlying CLI, must satisfy:

```
invoke(context: Context) → { output: string, choice: string }
```

Where `choice` is one of the labels declared in `node.options`. The orchestrator matches `choice` to an edge and follows it.

---

### Agent Registry

The registry maps agent ids to invocation definitions. It is separate from the graph — the registry describes your toolchain, the graph describes a specific task. They change at different rates.

```typescript
type AgentDefinition = {
  command: string       // binary or script to invoke
  systemPrompt: string  // base identity + expected output format
}

type AgentRegistry = Record<string, AgentDefinition>
```

---

### System Prompt Assembly

The adapter merges three layers in order:

```
1. registry[node.agent].systemPrompt   — base identity and output format
2. node.systemPrompt                   — task-specific override (optional)
3. options prompt                      — declared choices (always last, injected by adapter)
```

The options prompt is never hand-authored. The adapter generates it from `Object.keys(node.options)` and instructs the agent to select exactly one label using the sentinel format.

---

### Context Format

Context is a flat key-value map:

```typescript
type Context = Record<string, string>
```

**Append**: when a node completes, its output is written to context keyed by `node.id`. Subsequent runs of the same node id overwrite the previous value (last iteration wins).

**Slice**: the adapter filters context to the declared keys before building the agent's prompt.

**Rendered to agent** as labeled sections in the user prompt:

```
[task]
Build a payment integration for Stripe

[plan]
## Steps
1. Create /src/payments/stripe.ts
...
```

**Instruction** (if present on the node) is prepended above the labeled sections, making the semantic handoff explicit:

```
Implement the plan described in [plan]

[task]
...

[plan]
...
```

---

### Adapters

Each CLI has an adapter that encapsulates its real invocation contract. Adapters are **not interchangeable** — the CLIs differ in how they accept system prompts and produce structured output.

**Claude Code adapter**

```bash
echo "$rendered_context" | claude -p "$instruction" \
  --system-prompt "$merged_system_prompt" \
  --output-format json \
  --json-schema '{"type":"object","properties":{"output":{"type":"string"},"choice":{"type":"string","enum":[...]}}}' \
  --dangerously-skip-permissions \
  --cwd "$node.cwd"
```

Output is schema-enforced JSON. No parsing logic needed.

**Copilot CLI adapter**

```bash
copilot -p "$full_prompt" --autopilot --yolo
```

No `--system-prompt` flag — system prompt and options are embedded in the prompt text. Output is free-form. The adapter extracts `{output, choice}` using a sentinel block:

```
---CHOICE---
needs_work
---END---
```

If no valid sentinel is found, the adapter re-invokes once with an appended instruction noting the missing choice. Hard fail after one retry.

---

### tmux Layout

Each active node runs in its own tmux pane. Panes close automatically on node completion. The orchestrator log pane is permanent — it is the only persistent surface for reconstructing run history.

**Orchestrator log format**:

```
[12:03:01] START   analyze          agent: planner
[12:03:08] CHOICE  analyze          → needs_research
[12:03:08] START   research         agent: claude_code
[12:03:31] FORK    fork_tests       → [test_unit, test_integration]
[12:03:31] START   test_unit        agent: copilot
[12:03:31] START   test_integration agent: copilot
[12:03:44] DONE    test_integration (1/2)
[12:03:51] DONE    test_unit        (2/2)
[12:03:51] JOIN    merge_tests      unblocked
[12:04:12] CHOICE  merge_tests      → all_passed
[12:04:12] DONE    graph
```

---

### Concurrency Model

Fork spawns all target nodes simultaneously via `Promise.all`. Each branch appends to context independently — no collision risk because keys are namespaced by node id. Join unblocks naturally when `Promise.all` resolves.

The orchestrator's internal state during a Fork:

```typescript
{ joinId → Set<completedNodeIds> }
```

The Join node declares `waits_for` explicitly. The orchestrator does not infer the count — it reads it.

---

### Fallback and Pause

Every node has a fallback — either the node-level override or the graph-level default. The fallback always routes to a `Paused` node.

On pause, the orchestrator writes a state file:

```typescript
type PausedState = {
  runId: string
  nodeId: string        // where execution stopped
  context: Context      // full context at pause time
  agentOutput: string   // what the agent produced
}
```

The human reviews the state file, then resumes:

```bash
Supertinker resume --run <runId> --choice <label>
```

The orchestrator loads `state.json`, injects the human choice, follows the edge, continues. The human may also patch the graph before resuming — adding a new option covers cases the original author didn't anticipate.

---

### Run Identity

Each run is a directory:

```
/tmp/orchestrator/<runId>/
  state.json       # written only when Paused
  context.json     # live context buffer
  orchestrator.log # persistent log
```

`runId` format: `{graph.id}-{Date.now()}` — unique, human-readable in tmux pane titles.

---

## Package API

```typescript
// Programmatic
import { run } from "Supertinker"
import { graph }    from "./graph"
import { registry } from "./registry"

run({ graph, registry })

// CLI
Supertinker run --graph ./graph.ts --registry ./registry.ts
Supertinker resume --run plan-develop-review-1234567890 --choice approved
```

**Exported types**: `Graph`, `Node`, `AgentRegistry`, `AgentDefinition`, `Context`, `PausedState`

The user owns `graph.ts` and `registry.ts`. The package owns everything else.

---

## Example: Plan → Develop → Review

```typescript
// registry.ts
export const registry: AgentRegistry = {
  planner: {
    command: "claude",
    systemPrompt: `You are a planning agent.
Analyze the task and produce a structured implementation plan in this format:

## Steps
1. ...

## Files
- path/to/file.ts — description`
  },

  claude_code: {
    command: "claude",
    systemPrompt: `You are a senior TypeScript engineer.
Implement the plan precisely and completely.

When done, summarize in this format:

## Implemented
- what was done

## Notes
- anything the reviewer should know`
  },

  reviewer: {
    command: "claude",
    systemPrompt: `You are a senior code reviewer.
Review the implementation against the plan.

Produce your review in this format:

## Verdict
approved | needs_work

## Feedback
- specific issues or confirmation`
  }
}
```

```typescript
// graph.ts
export const graph: Graph = {
  id: "plan-develop-review",
  start: "plan",
  fallback: "human_review",
  labels: ["done", "approved", "needs_work", "needs_clarify"],

  nodes: [
    {
      id: "plan",
      agent: "planner",
      instruction: "Analyze the task and produce a detailed implementation plan",
      options: {
        done:          "develop",
        needs_clarify: "human_review"
      }
    },
    {
      id: "develop",
      agent: "claude_code",
      cwd: "./src",
      slice: ["task", "plan"],
      instruction: "Implement the plan described in [plan]",
      options: {
        done:          "review",
        needs_clarify: "human_review"
      }
    },
    {
      id: "review",
      agent: "reviewer",
      slice: ["task", "plan", "develop"],
      instruction: "Review the implementation in [develop] against the plan in [plan]",
      options: {
        approved:   "done",
        needs_work: "develop"      // loop back — context accumulates across iterations
      }
    },

    { id: "done",         type: "done"   },
    { id: "human_review", type: "paused" }
  ]
}
```

---

## Implementation Size

| Layer | Responsibility | Est. Lines |
|---|---|---|
| Types | Graph, Node, Context, AgentResult, PausedState, Registry | ~60 |
| Orchestrator core | FSM loop, graph traversal, join tracking | ~80 |
| Context manager | Append, Slice, serialize/load from disk | ~40 |
| tmux adapter base | Pane lifecycle, spawn, capture stdout, close on done | ~60 |
| Claude Code adapter | Command builder, system prompt merge, JSON parse | ~50 |
| Copilot adapter | Prompt builder, sentinel parse, one retry | ~50 |
| Registry loader | Resolve agent definition from id | ~20 |
| Resume CLI | Load state.json, inject choice, hand back to orchestrator | ~30 |
| Orchestrator log | tmux pane writer, structured entries | ~30 |
| **Total** | | **~420 lines** |

No framework dependencies. Node stdlib + one process-spawning package (`execa` or `node-pty`).

---

## Open Questions

None. All design decisions are closed.