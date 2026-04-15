import type { Hook, HookEvent, HookDirective } from "../supertinker.js"

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
