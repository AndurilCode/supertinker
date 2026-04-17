# Workflows

A workflow is a TypeScript file exporting a `Workflow` object. Place it in `.supertinker/workflows/my-workflow.workflow.ts`.

## Full Schema

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

## Node Types

| `type` | Purpose | Required fields |
|--------|---------|-----------------|
| *(omitted)* | Standard — runs an agent | `agent`, `options` |
| `"fork"` | Fan-out: runs N branches in parallel | `targets: string[]` |
| `"join"` | Fan-in: waits for all branches | `waits_for: string[]` |
| `"subworkflow"` | Parses + executes a nested `Workflow` from context | `source: string` (context key) |
| `"done"` | Terminal — success | — |
| `"paused"` | Terminal — awaiting human input | — |
| `"failed"` | Terminal — unrecoverable error | — |

## GraphNode Full Schema

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

## Template Variable Warning

The `validate-templates` hook treats any `[word]` in `instruction` fields as a context variable reference. Unresolved references abort the run. Only use `[word]` for node IDs or context keys — use plain text or angle brackets for labels.

## Minimal Linear Workflow Example

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

## Fork/Join Example

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

## Guardrails

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
