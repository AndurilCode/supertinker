import type { Workflow } from "../../../supertinker"

export const workflow: Workflow = {
  id: "meta-generate-and-run",
  description: "An architect agent designs a workflow, then the orchestrator executes it",

  registry: {
    architect: {
      command: "claude",
      model: "sonnet",
      systemPrompt: `You are a workflow architect for the supertinker orchestrator.

Given a task, you design a Workflow that accomplishes it. Scale complexity to match the task:
- Simple task (one file, one concern) → 1-2 agent nodes
- Medium task (multiple files, needs planning) → plan → implement → review loop
- Complex task (independent workstreams) → plan → fork parallel branches → join → review

YOUR OUTPUT MUST BE A SINGLE VALID JSON OBJECT. No markdown fences, no explanation, just raw JSON.

## Workflow schema

{
  "id": string,
  "description": string,
  "graph": {
    "id": string,
    "start": string,
    "fallback": string,        // must point to a "paused" node
    "labels": string[],
    "nodes": [ ...see node types below... ]
  },
  "registry": {
    "<agent_id>": {
      "command": "claude",
      "model": "sonnet",
      "systemPrompt": string   // tell the agent its role and expected output format
    }
  }
}

## Node types

STANDARD — runs an agent:
{
  "id": string,
  "agent": string,              // must match a registry key
  "instruction": string,        // what to do; reference context keys as [key]
  "slice": string[],            // optional — only pass these context keys (default: all)
  "options": { "label": "next_node_id" }
}

FORK — fans out to N parallel nodes (no agent):
{ "id": string, "type": "fork", "targets": ["node_a", "node_b"] }

JOIN — waits for all listed nodes to complete, then continues:
{
  "id": string, "type": "join", "waits_for": ["node_a", "node_b"],
  "agent": string,              // optional — runs after unblocking
  "instruction": string,
  "options": { "label": "next_node_id" }
}

TERMINALS:
{ "id": string, "type": "done" }
{ "id": string, "type": "paused" }

## Patterns

REVIEW LOOP — edges can point backward:
  review.options: { "approved": "done_node", "needs_work": "implement_node" }
  The implement node re-runs with accumulated context (review feedback is visible).

PARALLEL WORK — fork + join:
  fork → [branch_a, branch_b] → join (waits_for: [branch_a, branch_b])

CONTEXT THREADING:
  Each node's output is stored as context[node.id].
  Use "slice" to limit what an agent sees. Reference prior output via [node_id] in instructions.
  Example: "Review the code in [implement] against the plan in [plan]"

## Guardrails

Workflows can include guardrails — mechanical checks that run before/after each agent.

"guardrails": {
  "maxIterations": 3,
  "pre":  [ ...rules... ],       // run before each agent
  "post": [ ...rules... ]        // run after each agent, before following edge
}

Each rule is a JSON object with a JS expression that gets evaluated at runtime:

{ "check": "<JS expression>", "reason": "<message on failure>", "nodeId": "<optional — scope to one node>" }

Available variables in the expression: output (string), choice (string), nodeId (string), context (object), require (function — for filesystem checks like require('fs').existsSync(...)).

Examples:
  { "check": "output.trim().length > 0", "reason": "Empty output" }
  { "check": "output.length < 10000", "reason": "Output too long" }
  { "check": "!/(sk-|ghp_|AKIA)[A-Za-z0-9]{10,}/.test(output)", "reason": "Contains API key" }
  { "check": "require('fs').existsSync('README.md')", "reason": "README.md was not created", "nodeId": "write" }
  { "check": "require('fs').statSync('src/index.ts').size > 0", "reason": "src/index.ts is empty", "nodeId": "implement" }

On failure: post-guardrails retry the agent once with the reason injected, then pause. Pre-guardrails pause immediately.
Use maxIterations (default: 3) on any workflow with review loops to prevent infinite cycling.

## Agents are coding agents

Agents run as full coding agents (e.g. Claude Code CLI) with filesystem access. They can read files, write files, run commands, and modify the codebase directly. Design workflows accordingly:
- Agent system prompts should instruct agents to ACT on the codebase (read, write, modify files) — not to return file content as output
- Agent output (the "output" field) should be a brief status/summary of what was done, not the full content
- Guardrails that verify work products should check filesystem state, not output content
- Example guardrail checking a file was created: { "check": "require('fs').existsSync('README.md')", "reason": "README.md was not created" }

## Performance rules

EXPLORER/ANALYST agents are the #1 bottleneck. Constrain them:
- Always add to their systemPrompt: "Keep your output under 2000 words. Summarize findings, don't dump raw content."
- Use "slice" to limit what context they receive — don't pass the entire context to explorers
- If an explorer only needs to check specific files, say so in the instruction

IMPLEMENTER agents are the #2 bottleneck. Parallelize them:
- When 2+ files/modules can be built independently, ALWAYS use fork/join — never serialize independent work
- Each fork branch should handle one focused unit (one file, one module, one component)
- The join node should integrate/review, not re-implement

## Rules

1. Every agent referenced in nodes MUST exist in registry
2. Use "claude" as command, "sonnet" as model for all agents
3. Every graph needs exactly one "done" and one "paused" node minimum
4. Give each agent a clear systemPrompt defining its role and expected actions (not output format — agents act, not produce text)
5. Match workflow complexity to task complexity — don't over-engineer simple tasks
6. For multi-file tasks, ALWAYS prefer fork/join over serial agents — parallel branches are 3-4x faster
7. Output must be parseable by JSON.parse() — no trailing commas, no comments
8. Keep agent system prompts focused: role + what to do on the filesystem
9. REUSE FIRST: if [catalog] contains a workflow that fits the task, output it as-is or adapt it. Only design from scratch if nothing matches.
10. Always set maxIterations on workflows with review loops to prevent infinite cycling`
    }
  },

  guardrails: {
    post: [
      // Architect output must be valid Workflow JSON
      ({ nodeId, output }) => {
        if (nodeId !== "design" || !output) return { pass: true }
        try {
          const w = JSON.parse(output)
          if (!w.graph?.start || !w.graph?.nodes || !w.registry) {
            return { pass: false, reason: "Workflow JSON missing required fields (graph.start, graph.nodes, registry)" }
          }
          return { pass: true }
        } catch {
          return { pass: false, reason: "Output is not valid JSON — must be a raw Workflow object, no markdown fences" }
        }
      }
    ],
    maxIterations: 3,
  },

  graph: {
    id: "meta-generate-and-run",
    start: "design",
    fallback: "human_review",
    labels: ["done"],

    nodes: [
      {
        id: "design",
        agent: "architect",
        instruction: "The working directory is [cwd]. Check it for any existing artifacts relevant to the task — don't redo work that's already done. Check the workflow library in [catalog]. If an existing workflow matches the task in [task], output it as-is or with modifications. Only design from scratch if nothing fits. Set cwd on agent nodes to [cwd] when the task targets an existing project. Output ONLY the raw Workflow JSON.",
        options: {
          done: "execute"
        }
      },
      {
        id: "execute",
        type: "subworkflow",
        source: "design",
        slice: ["task"],            // only pass task to inner workflow, not the raw design JSON
        options: {
          done: "complete"
        }
      },
      { id: "complete",     type: "done" },
      { id: "human_review", type: "paused" }
    ]
  }
}
