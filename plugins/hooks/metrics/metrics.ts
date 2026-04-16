import { readFileSync, appendFileSync } from "fs"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

// ─── Provider-specific parsers ──────────────────────────────────────────────

interface Metrics {
  durationMs: number; costUsd: number; turns: number
  inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number
}

const EMPTY: Metrics = { durationMs: 0, costUsd: 0, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

function parseClaude(raw: string): Metrics | null {
  // Claude CLI outputs a single JSON object with top-level fields
  try {
    const data = JSON.parse(raw.trim())
    if (!data.duration_ms) return null
    const usage = data.modelUsage as Record<string, Record<string, number>> | undefined
    let input = 0, output = 0, cacheRead = 0, cacheWrite = 0
    if (usage) {
      for (const model of Object.values(usage)) {
        input += model.inputTokens ?? 0
        output += model.outputTokens ?? 0
        cacheRead += model.cacheReadInputTokens ?? 0
        cacheWrite += model.cacheCreationInputTokens ?? 0
      }
    }
    return {
      durationMs: data.duration_ms ?? 0,
      costUsd: data.total_cost_usd ?? 0,
      turns: data.num_turns ?? 0,
      inputTokens: input, outputTokens: output,
      cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite,
    }
  } catch { return null }
}

function parseCopilot(raw: string): Metrics | null {
  // Copilot CLI outputs JSONL events; look for session.end or aggregate from events
  const lines = raw.trim().split("\n")
  let turns = 0, durationMs = 0, startTime = 0
  for (const line of lines) {
    try {
      const evt = JSON.parse(line)
      if (evt.type === "session.start" && evt.data?.timestamp) startTime = new Date(evt.data.timestamp).getTime()
      if (evt.type === "assistant.message") turns++
      // Copilot doesn't currently expose token counts or cost in JSONL
      // Duration derived from first to last event timestamp
      if (evt.data?.timestamp) durationMs = new Date(evt.data.timestamp).getTime() - (startTime || 0)
    } catch { /* not JSON */ }
  }
  if (turns === 0) return null
  return { ...EMPTY, durationMs, turns }
}

const PARSERS: Record<string, (raw: string) => Metrics | null> = {
  claude: parseClaude,
  copilot: parseCopilot,
}

// ─── Per-run accumulator ────────────────────────────────────────────────────

interface RunTotals extends Metrics { agents: number }

const totals = new Map<string, RunTotals>()

function accum(runId: string): RunTotals {
  if (!totals.has(runId)) totals.set(runId, { ...EMPTY, agents: 0 })
  return totals.get(runId)!
}

// ─── Output ─────────────────────────────────────────────────────────────────

function write(event: HookEvent, level: string, nodeId: string, msg: string): void {
  const ts = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] ${level.padEnd(7)} ${nodeId.padEnd(22)} ${msg}`
  appendFileSync(join(event.runDir, "orchestrator.log"), line + "\n")
  if (!process.env.SUPERTINKER_QUIET_LOGGER) process.stdout.write(line + "\n")
}

// ─── Hook ───────────────────────────────────────────────────────────────────

export const hook: Hook = {
  name: "metrics",
  description: "Per-agent and per-run token usage, cost, and duration from provider logs",
  events: ["PostAgent", "RunEnd"],
  parallel: true,
  priority: 10,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    if (event.event === "PostAgent") {
      const e = event as Extract<HookEvent, { event: "PostAgent" }>
      const logPath = join(event.runDir, `${e.nodeId}.log`)

      let raw: string
      try { raw = readFileSync(logPath, "utf8") } catch { return { action: "continue" } }

      const parser = PARSERS[e.provider]
      const m = parser?.(raw) ?? parseClaude(raw) ?? parseCopilot(raw)  // fallback: try both
      if (!m) return { action: "continue" }

      const t = accum(event.runId)
      t.agents++; t.durationMs += m.durationMs; t.costUsd += m.costUsd; t.turns += m.turns
      t.inputTokens += m.inputTokens; t.outputTokens += m.outputTokens
      t.cacheReadTokens += m.cacheReadTokens; t.cacheWriteTokens += m.cacheWriteTokens

      const durS = (m.durationMs / 1000).toFixed(0)
      const parts = [`${durS}s`, `${m.turns} turns`]
      if (m.costUsd > 0) parts.push(`$${m.costUsd.toFixed(3)}`)
      if (m.outputTokens > 0) parts.push(`out:${m.outputTokens}`)
      const totalInput = m.inputTokens + m.cacheReadTokens + m.cacheWriteTokens
      if (totalInput > 0 && m.cacheReadTokens > 0) {
        parts.push(`cache:${((m.cacheReadTokens / totalInput) * 100).toFixed(0)}%`)
      }
      write(event, "METRIC", e.nodeId, parts.join("  "))
    }

    if (event.event === "RunEnd") {
      const t = totals.get(event.runId)
      if (!t || t.agents === 0) return { action: "continue" }
      const durS = (t.durationMs / 1000).toFixed(0)
      const parts = [`${t.agents} agents`, `${durS}s`, `${t.turns} turns`]
      if (t.costUsd > 0) parts.push(`$${t.costUsd.toFixed(3)}`)
      parts.push(`in:${t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens}  out:${t.outputTokens}`)
      write(event, "METRIC", "run-total", parts.join("  "))
      totals.delete(event.runId)
    }

    return { action: "continue" }
  },
}
