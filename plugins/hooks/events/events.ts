import { appendFileSync } from "fs"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

/**
 * NDJSON event stream hook.
 *
 * Writes one JSON line per lifecycle event to {runDir}/events.ndjson.
 * Machine-readable companion to the human-readable text logger.
 *
 * Query examples:
 *   jq 'select(.event == "PostAgent")' events.ndjson
 *   jq 'select(.event == "Error")' events.ndjson
 *   jq '[.[] | select(.event == "PostAgent")] | sort_by(.duration_ms) | reverse | .[0]' events.ndjson
 */

function extractPayload(event: HookEvent): Record<string, unknown> {
  switch (event.event) {
    case "RunStart": {
      const e = event as Extract<HookEvent, { event: "RunStart" }>
      return {
        workflow: e.workflow.id,
        description: e.workflow.description,
        nodeCount: e.workflow.graph.nodes.length,
        contextKeys: Object.keys(e.initialContext),
      }
    }
    case "RunEnd": {
      const e = event as Extract<HookEvent, { event: "RunEnd" }>
      return {
        terminal: e.terminal,
        contextKeys: Object.keys(e.finalContext),
        contextSize: JSON.stringify(e.finalContext).length,
      }
    }
    case "PreAgent": {
      const e = event as Extract<HookEvent, { event: "PreAgent" }>
      return {
        nodeId: e.nodeId,
        agent: e.agent,
        provider: e.provider,
        promptLen: e.userPrompt.length,
        systemPromptLen: e.systemPrompt.length,
        slicedKeys: Object.keys(e.slicedContext),
      }
    }
    case "PostAgent": {
      const e = event as Extract<HookEvent, { event: "PostAgent" }>
      return {
        nodeId: e.nodeId,
        agent: e.agent,
        provider: e.provider,
        choice: e.result.choice,
        outputLen: e.result.output.length,
        transcriptPath: e.transcriptPath,
      }
    }
    case "PreProvider": {
      const e = event as Extract<HookEvent, { event: "PreProvider" }>
      return {
        nodeId: e.nodeId,
        agent: e.agent,
        provider: e.provider,
        cwd: e.cwd,
        model: e.model,
      }
    }
    case "Paused": {
      const e = event as Extract<HookEvent, { event: "Paused" }>
      return { nodeId: e.nodeId, reason: e.reason, stateFile: e.stateFile }
    }
    case "Resumed": {
      const e = event as Extract<HookEvent, { event: "Resumed" }>
      return { nodeId: e.nodeId, choice: e.choice }
    }
    case "ForkStart": {
      const e = event as Extract<HookEvent, { event: "ForkStart" }>
      return { nodeId: e.nodeId, targets: e.targets }
    }
    case "ForkJoin": {
      const e = event as Extract<HookEvent, { event: "ForkJoin" }>
      return { nodeId: e.nodeId, joinedFrom: e.joinedFrom }
    }
    case "GuardrailFail": {
      const e = event as Extract<HookEvent, { event: "GuardrailFail" }>
      return { nodeId: e.nodeId, phase: e.phase, reason: e.reason }
    }
    case "SubworkflowStart": {
      const e = event as Extract<HookEvent, { event: "SubworkflowStart" }>
      return {
        nodeId: e.nodeId,
        innerWorkflowId: e.innerWorkflow.id,
        innerNodeCount: e.innerWorkflow.graph.nodes.length,
      }
    }
    case "SubworkflowEnd": {
      const e = event as Extract<HookEvent, { event: "SubworkflowEnd" }>
      return {
        nodeId: e.nodeId,
        innerContextKeys: Object.keys(e.innerContext),
        innerContextSize: JSON.stringify(e.innerContext).length,
      }
    }
    case "Error": {
      const e = event as Extract<HookEvent, { event: "Error" }>
      return { nodeId: e.nodeId, error: e.error, fallbackNodeId: e.fallbackNodeId }
    }
    default:
      return {}
  }
}

// Track PreAgent timestamps to compute duration on PostAgent
const agentStartTimes = new Map<string, number>()

export const hook: Hook = {
  name: "events",
  description: "NDJSON event stream — writes machine-readable JSON lines to events.ndjson",
  events: [
    "RunStart", "RunEnd", "PreAgent", "PreProvider", "PostAgent", "Paused", "Resumed",
    "ForkStart", "ForkJoin", "GuardrailFail", "SubworkflowStart", "SubworkflowEnd", "Error",
  ],
  parallel: true,
  priority: 1,  // just after logger (priority 0)

  handler: async (event: HookEvent): Promise<HookDirective> => {
    const payload = extractPayload(event)

    // Track agent duration
    if (event.event === "PreAgent") {
      const e = event as Extract<HookEvent, { event: "PreAgent" }>
      agentStartTimes.set(`${event.runId}:${e.nodeId}`, event.timestamp)
    }
    if (event.event === "PostAgent") {
      const e = event as Extract<HookEvent, { event: "PostAgent" }>
      const startKey = `${event.runId}:${e.nodeId}`
      const start = agentStartTimes.get(startKey)
      if (start) {
        ;(payload as Record<string, unknown>).duration_ms = event.timestamp - start
        agentStartTimes.delete(startKey)
      }
    }

    const line = JSON.stringify({
      ts: new Date(event.timestamp).toISOString(),
      event: event.event,
      runId: event.runId,
      ...payload,
    })

    appendFileSync(join(event.runDir, "events.ndjson"), line + "\n")

    return { action: "continue" }
  },
}
