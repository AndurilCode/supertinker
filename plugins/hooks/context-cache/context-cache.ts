/**
 * context-cache.ts — Content-addressable node-output memoization for supertinker
 *
 * ┌─────────────────────────────────────────────────────────────────────────┐
 * │  Drop-in locations                                                      │
 * │    Project-level: <project>/.supertinker/hooks/context-cache.ts         │
 * │    User-level:    ~/.supertinker/hooks/context-cache.ts                 │
 * │  Cache dir:       ~/.supertinker/cache/<workflowId>/<key16>.json        │
 * └─────────────────────────────────────────────────────────────────────────┘
 *
 * THE PROBLEM
 * ───────────
 * Re-running a workflow from scratch re-executes every node, even ones whose
 * inputs haven't changed.  A single fixed node in a 10-node workflow costs the
 * full token budget of every preceding step.  The pause/resume system handles
 * *clean* interruptions but cannot help when you re-run from the top.
 *
 * THE SOLUTION
 * ────────────
 * At PostAgent, persist each completed node's output + routing choice to a
 * content-addressed cache file.  At PreAgent, if a cache entry matches:
 *
 *   1. Inject the cached output into the live mutable context  (PreAgent
 *      receives a direct reference to state.context — no core change needed).
 *   2. Write context.json immediately for crash durability.
 *   3. Return  { action: "redirect", targetNodeId: nextNodeId }  to jump
 *      the orchestrator directly to the correct next node, bypassing provider
 *      invocation entirely.
 *
 * FIRST USE OF redirect ON PreAgent
 * ──────────────────────────────────
 * The retry hook (PostAgent) was the first plugin to use the "redirect"
 * directive — redirecting a node back to itself for transient-failure retry.
 * This hook is the first to use "redirect" on PreAgent, and the first to
 * redirect to a *different* node (the cached next hop) rather than to self.
 *
 * Why not "skip"?
 * "skip" on PreAgent routes to resolveFallback() — the error handler — which
 * is wrong for a successful cache hit.  "redirect" to the computed nextNodeId
 * is the only correct approach.
 *
 * CACHE INVALIDATION
 * ──────────────────
 * Key = sha256(workflowId + "\0" + nodeId + "\0" + userPrompt).slice(0, 16)
 *
 * userPrompt is assembled by the core from node.instruction + sliceContext
 * before PreAgent fires, so it captures every upstream output that feeds this
 * node.  If any ancestor changes, the prompt changes, the key changes, and
 * this node re-runs.  No manual cache invalidation is ever needed.
 *
 * Stale-option guard: if the cached choice is no longer in node.options (e.g.
 * the workflow was refactored), the hook falls through to normal execution and
 * overwrites the entry after the fresh run.
 *
 * OPT-OUT
 * ───────
 * • SUPERTINKER_NO_CACHE=1         — disable for the entire run
 * • context["_no_cache:<nodeId>"]  — disable for one specific node
 *   (set in initialContext or inject via another PreAgent hook)
 *
 * COEXISTENCE
 * ───────────
 * parallel: true + priority: 5.  On PostAgent, we yield one microtick before
 * reading result.output so that sanitize-json (also parallel, priority 1)
 * can strip markdown fences first — otherwise we'd cache fenced output.
 * On PreAgent cache hits, the context mutation + redirect still wins the
 * directive ranking (redirect outranks continue), so parallel hooks that
 * already started are harmless — they observe a context that already has
 * context[nodeId] set.
 */

import { createHash }                              from "crypto"
import { existsSync, mkdirSync, readFileSync,
         writeFileSync }                           from "fs"
import { join }                                    from "path"
import { homedir }                                 from "os"
import type { Hook, HookEvent, HookDirective,
              Graph }                              from "../../../supertinker.js"

// ─── In-memory run registry ───────────────────────────────────────────────────

interface RunMeta {
  workflowId: string
  graph:      Graph
}

/** Populated at RunStart, consumed by PreAgent/PostAgent, pruned at RunEnd. */
const runRegistry = new Map<string, RunMeta>()

/**
 * Maps "runId:nodeId" → the cache key that was computed at PreAgent (miss).
 * PostAgent reads and deletes this entry to know what key to write.
 * Absence means the node was a cache hit — nothing to persist.
 */
const pendingKeys = new Map<string, string>()

// ─── Cache entry schema ───────────────────────────────────────────────────────

interface CacheEntry {
  /** The agent's full text output. */
  output:   string
  /** The choice sentinel that determined the next node. */
  choice:   string
  /** Informational: nodeId this entry belongs to. */
  nodeId:   string
  /** Informational: runId that produced this entry. */
  sourceRunId: string
  /** Unix ms timestamp of when this entry was written. */
  cachedAt: number
}

// ─── Filesystem helpers ───────────────────────────────────────────────────────

const CACHE_DIR = join(homedir(), ".supertinker", "cache")

/**
 * 16-hex-char content-addressable key for (workflowId, nodeId, userPrompt).
 * Changing any input produces a different key → automatic invalidation.
 */
function computeKey(workflowId: string, nodeId: string, userPrompt: string): string {
  return createHash("sha256")
    .update(`${workflowId}\x00${nodeId}\x00${userPrompt}`)
    .digest("hex")
    .slice(0, 16)
}

function workflowCacheDir(workflowId: string): string {
  const d = join(CACHE_DIR, workflowId)
  mkdirSync(d, { recursive: true })
  return d
}

function readEntry(workflowId: string, key: string): CacheEntry | null {
  const p = join(workflowCacheDir(workflowId), `${key}.json`)
  if (!existsSync(p)) return null
  try { return JSON.parse(readFileSync(p, "utf8")) as CacheEntry }
  catch { return null }
}

function writeEntry(workflowId: string, key: string, entry: CacheEntry): void {
  writeFileSync(
    join(workflowCacheDir(workflowId), `${key}.json`),
    JSON.stringify(entry, null, 2),
  )
}

// ─── Logging (mirrors the format used by logger.ts) ──────────────────────────

function log(runDir: string, tag: string, nodeId: string, msg: string): void {
  const ts   = new Date().toISOString().slice(11, 19)
  const line = `[${ts}] ${tag.padEnd(8)} ${nodeId.padEnd(22)} ${msg}\n`
  process.stdout.write(line)
  try { writeFileSync(join(runDir, "orchestrator.log"), line, { flag: "a" }) } catch { /* non-fatal */ }
}

// ─── Hook export ──────────────────────────────────────────────────────────────

export const hook: Hook = {
  name: "context-cache",
  description:
    "Content-addressable node-output memoization. " +
    "First plugin to use redirect on PreAgent: on cache hit, injects cached " +
    "output into the live context and redirects directly to the correct next " +
    "node, skipping provider invocation entirely.",

  events:   ["RunStart", "PreAgent", "PostAgent", "RunEnd"],

  parallel: true,
  priority: 5,
  timeout:  5_000,

  handler: async (event: HookEvent): Promise<HookDirective> => {

    // ── Global opt-out ──────────────────────────────────────────────────────
    if (process.env["SUPERTINKER_NO_CACHE"] === "1") return { action: "continue" }

    // ── RunStart: register workflow metadata ────────────────────────────────
    if (event.event === "RunStart") {
      const e = event as Extract<HookEvent, { event: "RunStart" }>
      runRegistry.set(event.runId, {
        workflowId: e.workflow.id,
        graph:      e.workflow.graph,
      })
      log(event.runDir, "CACHE", "—", `registered workflow "${e.workflow.id}" for run ${event.runId}`)
      return { action: "continue" }
    }

    // ── RunEnd: clean up in-memory state ────────────────────────────────────
    if (event.event === "RunEnd") {
      runRegistry.delete(event.runId)
      const prefix = `${event.runId}:`
      for (const k of [...pendingKeys.keys()]) {
        if (k.startsWith(prefix)) pendingKeys.delete(k)
      }
      return { action: "continue" }
    }

    // ── PreAgent: check cache ───────────────────────────────────────────────
    if (event.event === "PreAgent") {
      const e    = event as Extract<HookEvent, { event: "PreAgent" }>
      const meta = runRegistry.get(event.runId)
      if (!meta) return { action: "continue" }   // safety: RunStart not observed

      // Per-node opt-out via context key
      if (event.context[`_no_cache:${e.nodeId}`] === "1") {
        log(event.runDir, "CACHE", e.nodeId, "opt-out via context key — skipping cache lookup")
        return { action: "continue" }
      }

      const key   = computeKey(meta.workflowId, e.nodeId, e.userPrompt)
      const entry = readEntry(meta.workflowId, key)

      // ── Cache miss: record key for PostAgent to persist ─────────────────
      if (!entry) {
        pendingKeys.set(`${event.runId}:${e.nodeId}`, key)
        log(event.runDir, "CACHE", e.nodeId, `miss  key=${key}`)
        return { action: "continue" }
      }

      // ── Cache hit: validate the routing choice against current graph ────
      const node = meta.graph.nodes.find(n => n.id === e.nodeId)
      if (!node?.options) {
        // Terminal or non-routing node — should not reach PreAgent, but be safe
        log(event.runDir, "CACHE", e.nodeId, `WARN hit but node has no options — re-running`)
        pendingKeys.set(`${event.runId}:${e.nodeId}`, key)
        return { action: "continue" }
      }

      const nextNodeId = node.options[entry.choice]
      if (!nextNodeId) {
        // Workflow was refactored; cached choice is stale — run fresh
        log(event.runDir, "CACHE", e.nodeId,
          `WARN stale choice "${entry.choice}" not in options [${Object.keys(node.options).join(", ")}] — re-running`)
        pendingKeys.set(`${event.runId}:${e.nodeId}`, key)
        return { action: "continue" }
      }

      // ── Inject cached output into the live mutable context ──────────────
      //
      // PreAgent fires with event.context === state.context (a direct reference,
      // not a frozen copy — see supertinker.ts line 384).  Writing here propagates
      // into the run state without any core modification.
      event.context[e.nodeId] = entry.output

      // Persist immediately so a crash between this redirect and the next
      // saveContext call doesn't lose the injected value.
      try {
        writeFileSync(
          join(event.runDir, "context.json"),
          JSON.stringify(event.context, null, 2),
        )
      } catch { /* non-fatal: value is live in state.context regardless */ }

      log(event.runDir, "CACHE", e.nodeId,
        `hit   key=${key}  choice="${entry.choice}" → redirect to "${nextNodeId}"`)

      // ── First use of redirect on PreAgent in the supertinker ecosystem ───
      //
      // The core's applyDirective handles this as:
      //   await executeNode(nextNodeId, nodeId /*as fromNodeId*/, state)
      //
      // Passing nodeId as fromNodeId is correct for join-node tracking: any
      // join that waits_for this node will see it as "arrived" even though
      // no agent ran.  The next node runs with context[nodeId] already set.
      return { action: "redirect", targetNodeId: nextNodeId }
    }

    // ── PostAgent: persist result to cache (miss path only) ────────────────
    if (event.event === "PostAgent") {
      const e    = event as Extract<HookEvent, { event: "PostAgent" }>
      const meta = runRegistry.get(event.runId)
      if (!meta) return { action: "continue" }

      const mapKey = `${event.runId}:${e.nodeId}`
      const key    = pendingKeys.get(mapKey)
      if (!key) return { action: "continue" }   // was a cache hit — nothing to write

      pendingKeys.delete(mapKey)

      // Defensive: strip markdown fences before caching so we never persist
      // fenced JSON even if sanitize-json hook hasn't run yet (parallel race).
      let output = e.result.output
      const trimmed = output.trim()
      if (/^```(?:json)?\s*\n?/i.test(trimmed)) {
        output = trimmed.replace(/^```(?:json)?\s*\n?/i, "").replace(/\n?```\s*$/i, "").trim()
      }

      writeEntry(meta.workflowId, key, {
        output,
        choice:      e.result.choice,
        nodeId:      e.nodeId,
        sourceRunId: event.runId,
        cachedAt:    Date.now(),
      })

      log(event.runDir, "CACHE", e.nodeId,
        `save  key=${key}  choice="${e.result.choice}"`)
    }

    return { action: "continue" }
  },
}
