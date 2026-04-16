import type { Workflow } from "../../../supertinker"

export const workflow: Workflow = {
  id: "meta-generate-and-run",
  description: "An architect agent designs a workflow, then a reviewer validates alignment, then the orchestrator executes it",

  registry: {
    architect: {
      command: "claude",
      model: "sonnet",
      systemPrompt: `You are a workflow architect for the supertinker orchestrator.
Given a task, design a Workflow JSON. Scale complexity to the task:
- Simple (one file, one concern) → 1-2 agent nodes
- Medium (multiple files, needs planning) → plan → implement → review loop
- Complex (independent workstreams) → plan → fork parallel branches → join → review

YOUR OUTPUT MUST BE A SINGLE VALID JSON OBJECT. No markdown fences, no explanation.

NODE TYPES (by example):
  Standard: { "id": "x", "agent": "a", "instruction": "do [plan]", "slice": ["plan"], "options": {"done": "next"} }
  Fork:     { "id": "x", "type": "fork", "targets": ["a", "b"] }
  Join:     { "id": "x", "type": "join", "waits_for": ["a", "b"], "agent": "a", "instruction": "...", "options": {"done": "next"} }
  Done:     { "id": "x", "type": "done" }
  Paused:   { "id": "x", "type": "paused" }

PATTERNS:
  Review loop — point an option edge backward: { "approved": "done_node", "needs_work": "implement_node" }
  Parallel — fork → [branches] → join. ALWAYS use fork/join when 2+ units are independent (3-4x faster).
  Context — each node's output stored as context[node.id]. Reference via [node_id] in instructions. Use "slice" to limit what an agent sees.

RUNTIME CONTRACT — what agents see at execution time:
  - A sentinel block is auto-injected listing choice options. Do NOT repeat choice instructions in your systemPrompts.
  - Context arrives as [key]\\nvalue sections in the user prompt. Instructions reference prior output via [key].
  - Agents run as full coding agents (Claude Code CLI) with filesystem access in cwd. They ACT on the codebase — output should be a brief status, not file content.
  - Fork branches get automatic git worktree isolation. The _worktree context key is set by the runtime.

PERFORMANCE:
  Explorer/analyst agents: add "Keep output under 2000 words" to systemPrompt, use slice to limit context.
  Implementer agents: parallelize with fork/join — never serialize independent work.

SEPARATION OF CONCERNS in review loops:
  - Design/architect nodes produce PLANS and SPECIFICATIONS (text), not source code. Their output is a description of what to build.
  - Implementer nodes write actual files to disk. Their output is a brief status of what was written.
  - Reviewer nodes in a design→review loop must review the DESIGN (feasibility, completeness, correctness of the plan) — never demand source code from a design node.
  - Reviewer nodes in an implement→review loop review the FILES ON DISK (read them via filesystem), not the agent output text.
  - NEVER ask a design node to include verbatim source code in its output — that's the implementer's job.

RULES:
  - Match complexity to task — don't over-engineer simple tasks
  - Use "claude" as command, "sonnet" as model for all agents
  - Agent systemPrompts must be actionable: role + what to do on the filesystem
  - Set maxIterations on workflows with review loops
  - REUSE FIRST: if [catalog] has a matching workflow, use or adapt it. Only design from scratch if nothing fits.
  - Output must be parseable by JSON.parse() — no trailing commas, no comments`
    },

    reviewer: {
      command: "claude",
      model: "sonnet",
      systemPrompt: `You validate that a generated workflow aligns with the original task.

Check these four things:
1. SCOPE MATCH — Does the workflow's complexity match the task? A simple rename must not produce 8 nodes. A complex refactor must not be a single agent.
2. AGENT PROMPTS — Is each agent's systemPrompt actionable? It must tell the agent what to do on the filesystem (read, write, modify), not just describe a role.
3. CONTEXT FLOW — Do slice arrays include the keys that instructions reference via [key]? If an instruction says "review [plan]", the slice must include "plan" or be omitted (default: all keys).
4. ERROR HANDLING — Does the workflow have a fallback node? Do complex flows have review loops with maxIterations?

If all four pass, select "aligned".
If any fail, select "misaligned" and explain specifically what is wrong: name the node IDs, the issue, and how to fix it.`
    }
  },

  guardrails: {
    post: [
      // Comprehensive graph validation for architect output
      ({ nodeId, output }) => {
        if (nodeId !== "design" || !output) return { pass: true }

        let w: any
        try { w = JSON.parse(output) }
        catch { return { pass: false, reason: "Output is not valid JSON — must be a raw Workflow object, no markdown fences" } }

        // Top-level fields
        if (!w.id || !w.description || !w.graph || !w.registry)
          return { pass: false, reason: "Workflow missing required top-level fields: id, description, graph, registry" }

        const g = w.graph
        if (!g.id || !g.start || !g.fallback)
          return { pass: false, reason: "graph missing required fields: id, start, fallback" }
        if (!Array.isArray(g.labels) || g.labels.length === 0)
          return { pass: false, reason: "graph.labels must be a non-empty array" }
        if (!Array.isArray(g.nodes) || g.nodes.length === 0)
          return { pass: false, reason: "graph.nodes must be a non-empty array" }

        // Node ID uniqueness
        const nodeIds = new Set<string>()
        for (const n of g.nodes) {
          if (nodeIds.has(n.id)) return { pass: false, reason: `Duplicate node ID: "${n.id}"` }
          nodeIds.add(n.id)
        }

        // start and fallback resolve
        if (!nodeIds.has(g.start))
          return { pass: false, reason: `graph.start "${g.start}" does not match any node ID` }
        if (!nodeIds.has(g.fallback))
          return { pass: false, reason: `graph.fallback "${g.fallback}" does not match any node ID` }
        const fallbackNode = g.nodes.find((n: any) => n.id === g.fallback)
        if (fallbackNode.type !== "paused")
          return { pass: false, reason: `graph.fallback must point to a "paused" node, but "${g.fallback}" has type "${fallbackNode.type ?? "standard"}"` }

        // Agent references exist in registry
        for (const n of g.nodes) {
          if (n.agent && !w.registry[n.agent])
            return { pass: false, reason: `Node "${n.id}" references agent "${n.agent}" not found in registry` }
        }

        // Option edges resolve
        for (const n of g.nodes) {
          if (!n.options) continue
          for (const [label, target] of Object.entries(n.options)) {
            if (!nodeIds.has(target as string))
              return { pass: false, reason: `Node "${n.id}" option "${label}" points to non-existent node "${target}"` }
          }
        }

        // Fork targets resolve
        for (const n of g.nodes) {
          if (n.type !== "fork") continue
          if (!Array.isArray(n.targets) || n.targets.length === 0)
            return { pass: false, reason: `Fork "${n.id}" must have a non-empty targets array` }
          for (const t of n.targets) {
            if (!nodeIds.has(t))
              return { pass: false, reason: `Fork "${n.id}" targets non-existent node "${t}"` }
          }
        }

        // Join waits_for resolve
        for (const n of g.nodes) {
          if (n.type !== "join") continue
          if (!Array.isArray(n.waits_for) || n.waits_for.length === 0)
            return { pass: false, reason: `Join "${n.id}" must have a non-empty waits_for array` }
          for (const wf of n.waits_for) {
            if (!nodeIds.has(wf))
              return { pass: false, reason: `Join "${n.id}" waits_for non-existent node "${wf}"` }
          }
        }

        // Terminal nodes exist
        const hasDone   = g.nodes.some((n: any) => n.type === "done")
        const hasPaused = g.nodes.some((n: any) => n.type === "paused")
        if (!hasDone || !hasPaused)
          return { pass: false, reason: "Workflow must have at least one 'done' node and one 'paused' node" }

        // Reachability BFS
        const visited = new Set<string>()
        const queue = [g.start]
        while (queue.length > 0) {
          const id = queue.shift()!
          if (visited.has(id)) continue
          visited.add(id)
          const node = g.nodes.find((n: any) => n.id === id)
          if (!node) continue
          if (node.options) for (const t of Object.values(node.options)) { if (!visited.has(t as string)) queue.push(t as string) }
          if (node.targets) for (const t of node.targets) { if (!visited.has(t)) queue.push(t) }
          if (node.fallback && !visited.has(node.fallback)) queue.push(node.fallback)
        }
        visited.add(g.fallback) // fallback is reachable via error paths
        const orphans = g.nodes.filter((n: any) => !visited.has(n.id)).map((n: any) => n.id)
        if (orphans.length > 0)
          return { pass: false, reason: `Unreachable nodes: ${orphans.join(", ")}` }

        // Registry agent systemPrompt quality
        for (const [key, def] of Object.entries(w.registry)) {
          const sp = (def as any).systemPrompt
          if (!sp || typeof sp !== "string" || sp.length < 20)
            return { pass: false, reason: `Agent "${key}" has empty or trivially short systemPrompt` }
        }

        return { pass: true }
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
          done: "review"
        }
      },
      {
        id: "review",
        agent: "reviewer",
        instruction: "The original task is in [task]. The generated workflow JSON is in [design]. Validate alignment.",
        slice: ["task", "design"],
        options: {
          aligned: "execute",
          misaligned: "design"
        }
      },
      {
        id: "execute",
        type: "subworkflow",
        source: "design",
        slice: ["task"],
        options: {
          done: "complete"
        }
      },
      { id: "complete",     type: "done" },
      { id: "human_review", type: "paused" }
    ]
  }
}
