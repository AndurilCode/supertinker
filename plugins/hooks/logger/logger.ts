import { appendFileSync } from "fs"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

function fmt(level: string, nodeId: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 19)
  return `[${ts}] ${level.padEnd(7)} ${nodeId.padEnd(22)} ${msg}`
}

function write(event: HookEvent, level: string, nodeId: string, msg: string): void {
  const line = fmt(level, nodeId, msg)
  appendFileSync(join(event.runDir, "orchestrator.log"), line + "\n")
  process.stdout.write(line + "\n")
}

export const hook: Hook = {
  name: "logger",
  description: "Built-in structured logging for all orchestrator events",
  events: [
    "RunStart", "RunEnd", "PreAgent", "PreProvider", "PostAgent", "Paused", "Resumed",
    "ForkStart", "ForkJoin", "GuardrailFail", "SubworkflowStart", "SubworkflowEnd", "Error",
  ],
  parallel: true,
  priority: 0,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    switch (event.event) {
      case "RunStart": {
        const e = event as Extract<HookEvent, { event: "RunStart" }>
        write(event, "RUN", e.runId, e.workflow.description)
        write(event, "RUN", e.runId, `graph: ${e.workflow.graph.id}  nodes: ${e.workflow.graph.nodes.length}  dir: ${e.runDir}`)
        break
      }
      case "RunEnd": {
        const e = event as Extract<HookEvent, { event: "RunEnd" }>
        if (e.terminal === "done") write(event, "DONE", "graph", "✓ completed")
        else write(event, "FAILED", "graph", "✗ failed")
        break
      }
      case "PreAgent": {
        const e = event as Extract<HookEvent, { event: "PreAgent" }>
        write(event, "START", e.nodeId, `agent: ${e.agent}`)
        break
      }
      case "PreProvider": {
        const e = event as Extract<HookEvent, { event: "PreProvider" }>
        write(event, "INVOKE", e.nodeId, `provider: ${e.provider}${e.model ? ` model: ${e.model}` : ""}`)
        break
      }
      case "PostAgent": {
        const e = event as Extract<HookEvent, { event: "PostAgent" }>
        write(event, "CHOICE", e.nodeId, `→ ${e.result.choice}`)
        break
      }
      case "Paused": {
        const e = event as Extract<HookEvent, { event: "Paused" }>
        if (e.reason) write(event, "GUARD", e.nodeId, e.reason)
        write(event, "PAUSED", e.nodeId, `state → ${e.stateFile}`)
        write(event, "PAUSED", e.nodeId, `resume: supertinker resume --run ${e.runId} --choice <label> --workflow <path>`)
        break
      }
      case "Resumed": {
        const e = event as Extract<HookEvent, { event: "Resumed" }>
        write(event, "RESUME", e.runId, `node: ${e.nodeId}  choice: ${e.choice}`)
        break
      }
      case "ForkStart": {
        const e = event as Extract<HookEvent, { event: "ForkStart" }>
        write(event, "FORK", e.nodeId, `→ [${e.targets.join(", ")}]`)
        break
      }
      case "ForkJoin": {
        const e = event as Extract<HookEvent, { event: "ForkJoin" }>
        write(event, "JOIN", e.nodeId, `${e.joinedFrom.length} branches joined`)
        break
      }
      case "GuardrailFail": {
        const e = event as Extract<HookEvent, { event: "GuardrailFail" }>
        write(event, "GUARD", e.nodeId, `${e.phase}-guardrail: ${e.reason}`)
        break
      }
      case "SubworkflowStart": {
        const e = event as Extract<HookEvent, { event: "SubworkflowStart" }>
        write(event, "SUBWORK", e.nodeId, `executing "${e.innerWorkflow.id}" (${e.innerWorkflow.graph.nodes.length} nodes)`)
        break
      }
      case "SubworkflowEnd": {
        const e = event as Extract<HookEvent, { event: "SubworkflowEnd" }>
        write(event, "SUBWORK", e.nodeId, "completed")
        break
      }
      case "Error": {
        const e = event as Extract<HookEvent, { event: "Error" }>
        write(event, "ERROR", e.nodeId, e.error)
        break
      }
    }

    return { action: "continue" }
  },
}
