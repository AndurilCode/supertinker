#!/usr/bin/env tsx
/**
 * supertinker.ts — A minimal agent orchestrator (~420 lines)
 *
 * Usage:
 *   tsx supertinker.ts run    --graph ./graph.ts --registry ./registry.ts
 *   tsx supertinker.ts resume --run <runId> --choice <label> --graph ./graph.ts --registry ./registry.ts
 */

import { spawn }                                              from "child_process"
import { appendFileSync, existsSync, mkdirSync,
         readdirSync, readFileSync, writeFileSync }           from "fs"
import { join, resolve }                                      from "path"
import { homedir }                                            from "os"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id:           string
  type?:        "fork" | "join" | "done" | "failed" | "paused" | "subworkflow"
  // standard node
  agent?:       string
  cwd?:         string
  slice?:       string[]
  instruction?: string
  systemPrompt?: string
  options?:     Record<string, string>   // { label → next node id }
  fallback?:    string                   // local override
  // fork
  targets?:     string[]
  // join
  waits_for?:   string[]
  // subworkflow
  source?:      string                   // context key containing Workflow JSON
}

export interface Graph {
  id:       string
  start:    string
  fallback: string
  labels:   string[]
  nodes:    GraphNode[]
}

export interface AgentDefinition {
  command:      string
  model?:       string    // e.g. "sonnet", "opus", "claude-sonnet-4-6"
  systemPrompt: string
}

export type AgentRegistry = Record<string, AgentDefinition>
export type Context       = Record<string, string>

export type GuardrailCheck = (ctx: {
  context:  Context
  nodeId:   string
  output?:  string
  choice?:  string
}) => { pass: true } | { pass: false; reason: string }

export interface GuardrailRule {
  check:   string    // JS expression — evaluated with { output, choice, nodeId, context } in scope
  reason:  string    // message on failure
  nodeId?: string    // if set, only applies to this node
}

export interface Guardrails {
  pre?:           (GuardrailCheck | GuardrailRule)[]
  post?:          (GuardrailCheck | GuardrailRule)[]
  maxIterations?: number
}

export interface Workflow {
  id:          string
  description: string
  graph:       Graph
  registry:    AgentRegistry
  guardrails?: Guardrails
}

interface AgentResult {
  output: string
  choice: string
}

export interface PausedState {
  runId:       string
  nodeId:      string
  context:     Context
  agentOutput: string
  reason?:     string
}

interface RunState {
  runId:           string
  runDir:          string
  context:         Context
  joinMap:         Map<string, Set<string>>
  iterationCounts: Map<string, number>
  graph:           Graph
  registry:        AgentRegistry
  guardrails:      Guardrails
  log:             Logger
}

type Logger = (level: string, nodeId: string, msg: string) => void

// ─── LOGGING ──────────────────────────────────────────────────────────────────

function makeLogger(logFile: string): Logger {
  return (level, nodeId, msg) => {
    const ts   = new Date().toISOString().slice(11, 19)
    const line = `[${ts}] ${level.padEnd(7)} ${nodeId.padEnd(22)} ${msg}`
    appendFileSync(logFile, line + "\n")
    process.stdout.write(line + "\n")
  }
}

// ─── TMUX ─────────────────────────────────────────────────────────────────────
// Each node gets a tmux window showing its live log via `tail -f`.
// The orchestrator log lives in a persistent window created at startup.
// Panes close automatically when execution completes.

function tmuxRunning(): boolean {
  return !!process.env.TMUX
}

function tmuxNewWindow(name: string, cmd: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    spawn("tmux", ["new-window", "-n", safe, cmd], { detached: true, stdio: "ignore" }).unref()
  } catch { /* not in tmux */ }
}

function tmuxKillWindow(name: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    spawn("tmux", ["kill-window", "-t", safe], { detached: true, stdio: "ignore" }).unref()
  } catch { /* ignore */ }
}

function openNodePane(nodeId: string, logFile: string): void {
  tmuxNewWindow(`node-${nodeId}`, `tail -f ${logFile}`)
}

function closeNodePane(nodeId: string): void {
  tmuxKillWindow(`node-${nodeId}`)
}

// ─── CONTEXT ──────────────────────────────────────────────────────────────────

function sliceContext(context: Context, keys?: string[]): Context {
  if (!keys) return context
  return Object.fromEntries(keys.filter(k => k in context).map(k => [k, context[k]]))
}

function renderUserPrompt(context: Context, instruction?: string): string {
  const sections = Object.entries(context)
    .map(([k, v]) => `[${k}]\n${v}`)
    .join("\n\n")
  return instruction ? `${instruction}\n\n${sections}` : sections
}

// Overwrite — last iteration wins (loop-safe, no version suffix)
function appendContext(context: Context, nodeId: string, output: string): void {
  context[nodeId] = output
}

// Validate that every [variable] reference in node instructions can be resolved.
// A reference is resolvable if it names a node in the graph (its output will be
// written to context when that node runs) or is already present in initialContext.
// Throws with a descriptive message listing every unresolved reference so the
// caller can fail fast before any agent is dispatched.
function validateTemplateVariables(graph: Graph, initialContext: Context): void {
  const nodeIds = new Set(graph.nodes.map(n => n.id))
  const unresolved: Array<{ nodeId: string; variable: string }> = []

  for (const node of graph.nodes) {
    if (!node.instruction) continue
    for (const match of node.instruction.matchAll(/\[(\w[\w-]*)\]/g)) {
      const variable = match[1]
      if (!nodeIds.has(variable) && !(variable in initialContext)) {
        unresolved.push({ nodeId: node.id, variable })
      }
    }
  }

  if (unresolved.length > 0) {
    const details = unresolved
      .map(({ nodeId, variable }) => `  • [${variable}] in node "${nodeId}"`)
      .join("\n")
    throw new Error(
      `Workflow "${graph.id}" has unresolved template variables.\n` +
      `Add them to initialContext before calling run():\n${details}`
    )
  }
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

function buildOptionsPrompt(options: Record<string, string>): string {
  const labels = Object.keys(options).join(" | ")
  return [
    "You MUST end your response with this exact sentinel block, selecting one option:",
    "",
    "---CHOICE---",
    "<label>",
    "---END---",
    "",
    `Available options: ${labels}`,
    "",
    "Do not invent options. Do not omit the sentinel block.",
  ].join("\n")
}

function buildSystemPrompt(registry: AgentRegistry, node: GraphNode): string {
  const def = registry[node.agent!]
  return [
    def.systemPrompt,
    node.systemPrompt,
    node.options ? buildOptionsPrompt(node.options) : undefined,
  ].filter(Boolean).join("\n\n")
}

// ─── PROCESS RUNNER ───────────────────────────────────────────────────────────

function runProcess(
  command: string,
  args: string[],
  stdinText: string,
  cwd: string,
  logFile: string,
): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(command, args, { cwd, env: process.env })
    let out = ""
    let err = ""

    proc.stdout.on("data", (chunk: Buffer) => {
      const txt = chunk.toString()
      out += txt
      appendFileSync(logFile, txt)      // live write → tmux tail sees it
    })
    proc.stderr.on("data", (chunk: Buffer) => { err += chunk.toString() })

    proc.on("close", code =>
      code === 0 ? res(out) : rej(new Error(`exit ${code}: ${err.slice(0, 300)}`))
    )

    if (stdinText) { proc.stdin.write(stdinText); proc.stdin.end() }
    else proc.stdin.end()
  })
}

// ─── ADAPTERS ─────────────────────────────────────────────────────────────────

// Claude Code: --json-schema enforces {output, choice} — no sentinel needed
async function adaptClaudeCode(
  node: GraphNode,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  logFile: string,
  model?: string,
): Promise<AgentResult> {
  const schema = JSON.stringify({
    type: "object",
    required: ["output", "choice"],
    properties: {
      output: { type: "string" },
      choice: { type: "string", enum: Object.keys(node.options!) },
    },
  })

  const args = [
    "-p", userPrompt,
    "--system-prompt", systemPrompt,
    "--output-format", "json",
    "--json-schema", schema,
    "--dangerously-skip-permissions",
    ...(model ? ["--model", model] : []),
  ]

  const raw  = await runProcess("claude", args, "", cwd, logFile)

  // Claude Code JSON output is wrapped: { type: "result", ..., structured_output: {output, choice} }
  const parsed = JSON.parse(raw.trim())
  if (parsed.output !== undefined && parsed.choice !== undefined) return parsed
  if (parsed.structured_output?.output !== undefined && parsed.structured_output?.choice !== undefined) return parsed.structured_output
  if (parsed.result) return JSON.parse(parsed.result)
  throw new Error(`Unexpected Claude Code output shape: ${raw.slice(0, 200)}`)
}

// Copilot CLI: sentinel block parsing + one retry
function parseSentinel(raw: string, options: Record<string, string>): AgentResult | null {
  const m = raw.match(/---CHOICE---\s*\n\s*(\S+)\s*\n\s*---END---/)
  if (!m) return null
  const choice = m[1].trim()
  if (!(choice in options)) return null
  const output = raw.slice(0, raw.indexOf("---CHOICE---")).trim()
  return { output, choice }
}

// Extract the agent's text from Copilot JSONL output
function extractCopilotContent(raw: string): string {
  const lines = raw.trim().split("\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i])
      if (evt.type === "assistant.message" && evt.data?.content) return evt.data.content
    } catch { /* not JSON — skip */ }
  }
  // Fallback: treat the whole output as plain text (e.g. if --output-format json wasn't used)
  return raw
}

async function adaptCopilot(
  node: GraphNode,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  logFile: string,
  model?: string,
  retry = false,
): Promise<AgentResult> {
  const retryHint = retry
    ? "\n\nWARNING: Your previous response was missing the ---CHOICE--- sentinel block. Include it now."
    : ""

  const fullPrompt = `${systemPrompt}\n\n${userPrompt}${retryHint}`
  const args = [
    "-p", fullPrompt,
    "--autopilot",
    "--yolo",
    "--output-format", "json",
    ...(model ? ["--model", model] : []),
  ]
  const raw = await runProcess("copilot", args, "", cwd, logFile)
  const content = extractCopilotContent(raw)
  const result = parseSentinel(content, node.options!)

  if (!result && !retry) return adaptCopilot(node, systemPrompt, userPrompt, cwd, logFile, model, true)
  if (!result) throw new Error(`No valid sentinel after retry. Output: ${content.slice(0, 300)}`)
  return result
}

// Generic adapter — works for any CLI that reads a prompt from args
// Uses the sentinel approach (same as Copilot)
async function adaptGeneric(
  command: string,
  node: GraphNode,
  systemPrompt: string,
  userPrompt: string,
  cwd: string,
  logFile: string,
): Promise<AgentResult> {
  const fullPrompt = `${systemPrompt}\n\n${userPrompt}`
  const raw = await runProcess(command, [fullPrompt], "", cwd, logFile)
  const result = parseSentinel(raw, node.options!)
  if (!result) throw new Error(`No valid sentinel. Output: ${raw.slice(0, 300)}`)
  return result
}

// ─── AGENT INVOCATION ─────────────────────────────────────────────────────────

async function invokeAgent(node: GraphNode, state: RunState): Promise<AgentResult> {
  const { registry, context, runDir } = state
  const def        = registry[node.agent!]
  const sliced     = sliceContext(context, node.slice)
  const userPrompt = renderUserPrompt(sliced, node.instruction)
  const sysPrompt  = buildSystemPrompt(registry, node)
  const cwd        = resolve(node.cwd ?? process.cwd())
  const logFile    = join(runDir, `${node.id}.log`)

  openNodePane(node.id, logFile)

  try {
    switch (def.command) {
      case "claude":  return await adaptClaudeCode(node, sysPrompt, userPrompt, cwd, logFile, def.model)
      case "copilot": return await adaptCopilot(node, sysPrompt, userPrompt, cwd, logFile, def.model)
      default:        return await adaptGeneric(def.command, node, sysPrompt, userPrompt, cwd, logFile)
    }
  } finally {
    await new Promise(r => setTimeout(r, 800))   // brief pause so human sees final output
    closeNodePane(node.id)
  }
}

// ─── GUARDRAILS ──────────────────────────────────────────────────────────────

function isRule(g: GuardrailCheck | GuardrailRule): g is GuardrailRule {
  return typeof g === "object" && "check" in g && "reason" in g
}

function evalRule(
  rule: GuardrailRule,
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): { pass: true } | { pass: false; reason: string } {
  if (rule.nodeId && rule.nodeId !== ctx.nodeId) return { pass: true }
  try {
    const { output = "", choice = "", nodeId, context } = ctx
    const pass = new Function("output", "choice", "nodeId", "context",
      `"use strict"; return !!(${rule.check})`
    )(output, choice, nodeId, context)
    return pass ? { pass: true } : { pass: false, reason: rule.reason }
  } catch (err) {
    return { pass: false, reason: `guardrail eval error: ${err}` }
  }
}

function runGuardrails(
  checks: (GuardrailCheck | GuardrailRule)[],
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): { pass: true } | { pass: false; reason: string } {
  for (const check of checks) {
    const result = isRule(check) ? evalRule(check, ctx) : check(ctx)
    if (!result.pass) return result
  }
  return { pass: true }
}

function pauseWithReason(
  state: RunState,
  nodeId: string,
  fromNodeId: string | null,
  reason: string,
): void {
  const { runDir, context, log } = state
  const paused: PausedState = {
    runId:       state.runId,
    nodeId:      fromNodeId ?? nodeId,
    context,
    agentOutput: context[fromNodeId ?? ""] ?? "",
    reason,
  }
  const stateFile = join(runDir, "state.json")
  writeFileSync(stateFile, JSON.stringify(paused, null, 2))
  writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))
  log("GUARD", nodeId, reason)
  log("PAUSED", nodeId, `state → ${stateFile}`)
  log("PAUSED", nodeId, `resume: supertinker resume --run ${state.runId} --choice <label> --workflow <path>`)
}

// ─── ORCHESTRATOR CORE ────────────────────────────────────────────────────────

async function executeNode(
  nodeId:     string,
  fromNodeId: string | null,
  state:      RunState,
): Promise<void> {
  const { graph, context, joinMap, runDir, log } = state
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) throw new Error(`Node not found: "${nodeId}"`)

  // ── Terminals ──────────────────────────────────────────────────────────────
  if (node.type === "done") {
    log("DONE", "graph", "✓ completed successfully")
    return
  }

  if (node.type === "failed") {
    log("FAILED", "graph", "✗ reached failed node")
    throw new Error("Graph reached a failed terminal")
  }

  if (node.type === "paused") {
    const paused: PausedState = {
      runId:       state.runId,
      nodeId:      fromNodeId ?? nodeId,
      context,
      agentOutput: context[fromNodeId ?? ""] ?? "",
    }
    const stateFile = join(runDir, "state.json")
    writeFileSync(stateFile, JSON.stringify(paused, null, 2))
    writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))
    log("PAUSED", nodeId, `state → ${stateFile}`)
    log("PAUSED", nodeId, `resume: supertinker resume --run ${state.runId} --choice <label> --workflow <path>`)
    return
  }

  // ── Fork ───────────────────────────────────────────────────────────────────
  if (node.type === "fork") {
    log("FORK", nodeId, `→ [${node.targets!.join(", ")}]`)
    await Promise.all(node.targets!.map(t => executeNode(t, nodeId, state)))
    return
  }

  // ── Join ───────────────────────────────────────────────────────────────────
  // Atomic in JS — no await between check and set, so no race condition
  if (node.type === "join") {
    if (!joinMap.has(nodeId)) joinMap.set(nodeId, new Set())
    const done = joinMap.get(nodeId)!
    if (fromNodeId) done.add(fromNodeId)

    log("JOIN", nodeId, `${done.size}/${node.waits_for!.length} complete`)

    if (done.size < node.waits_for!.length) return   // not the last branch
    // Last branch falls through — executes the join node as a standard node
  }

  // ── Subworkflow — execute an agent-generated workflow ─────────────────────
  if (node.type === "subworkflow") {
    const sourceKey = node.source!
    const raw = context[sourceKey]
    if (!raw) {
      log("ERROR", nodeId, `subworkflow source key "${sourceKey}" not found in context`)
      return executeNode(node.fallback ?? graph.fallback, nodeId, state)
    }

    let inner: Workflow
    try {
      inner = JSON.parse(raw)
    } catch (err) {
      log("ERROR", nodeId, `failed to parse subworkflow from "${sourceKey}": ${err}`)
      return executeNode(node.fallback ?? graph.fallback, nodeId, state)
    }

    // Save generated workflow as a reusable .workflow.ts file
    const workflowFile = join(runDir, `${inner.id}.workflow.ts`)
    const importPath = resolve("supertinker.ts").replace(/\.ts$/, "")
    const tsContent = `import type { Workflow } from "${importPath}";\n\nexport const workflow: Workflow = ${JSON.stringify(inner, null, 2)};\n`
    writeFileSync(workflowFile, tsContent)
    log("SUBWORK", nodeId, `workflow saved → ${workflowFile}`)
    log("SUBWORK", nodeId, `reuse: tsx supertinker.ts run --workflow ${workflowFile}`)
    log("SUBWORK", nodeId, `executing workflow "${inner.id}" (${inner.graph.nodes.length} nodes)`)

    const innerRunDir = join(runDir, `sub-${inner.id}`)
    mkdirSync(innerRunDir, { recursive: true })
    const innerLogFile = join(innerRunDir, "orchestrator.log")
    const innerLog = makeLogger(innerLogFile)

    // Only pass initialContext keys to inner workflow — not accumulated node outputs
    const innerContext: Context = {}
    for (const key of node.slice ?? Object.keys(context)) {
      if (key in context && key !== sourceKey) innerContext[key] = context[key]
    }

    const innerState: RunState = {
      runId:           `${state.runId}/${inner.id}`,
      runDir:          innerRunDir,
      context:         innerContext,
      joinMap:         new Map(),
      iterationCounts: new Map(),
      graph:           inner.graph,
      registry:        inner.registry,
      guardrails: {
        maxIterations: inner.guardrails?.maxIterations ?? state.guardrails.maxIterations,
        pre:           [...(state.guardrails.pre ?? []),  ...(inner.guardrails?.pre ?? [])],
        post:          [...(state.guardrails.post ?? []), ...(inner.guardrails?.post ?? [])],
      },
      log:             innerLog,
    }

    // Set cwd for inner workflow nodes that don't specify their own
    const innerCwd = node.cwd ? resolve(node.cwd) : undefined
    if (innerCwd) {
      for (const n of inner.graph.nodes) {
        if (!n.cwd && n.agent) n.cwd = innerCwd
      }
    }

    try {
      await executeNode(inner.graph.start, null, innerState)
    } catch (err) {
      log("ERROR", nodeId, `subworkflow failed: ${err}`)
      return executeNode(node.fallback ?? graph.fallback, nodeId, state)
    }

    // Merge inner context back under this node's id
    appendContext(context, nodeId, JSON.stringify(innerState.context))
    writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))

    // Save to workflow library for reuse
    const libraryDir = join(homedir(), ".supertinker", "workflows")
    mkdirSync(libraryDir, { recursive: true })
    const libraryFile = join(libraryDir, `${inner.id}.workflow.ts`)
    writeFileSync(libraryFile, tsContent)
    log("SUBWORK", nodeId, `library → ${libraryFile}`)
    log("SUBWORK", nodeId, `completed — context merged`)

    const nextNodeId = node.options?.["done"]
    if (!nextNodeId) return
    return executeNode(nextNodeId, nodeId, state)
  }

  // ── Standard node ──────────────────────────────────────────────────────────
  const { guardrails, iterationCounts } = state

  // Track iterations for maxIterations guardrail
  const count = (iterationCounts.get(nodeId) ?? 0) + 1
  iterationCounts.set(nodeId, count)

  if (guardrails.maxIterations && count > guardrails.maxIterations) {
    return pauseWithReason(state, nodeId, fromNodeId,
      `node "${nodeId}" exceeded max iterations (${guardrails.maxIterations})`)
  }

  // Pre-guardrails
  if (guardrails.pre?.length) {
    const pre = runGuardrails(guardrails.pre, { context, nodeId })
    if (!pre.pass) {
      return pauseWithReason(state, nodeId, fromNodeId, `pre-guardrail: ${pre.reason}`)
    }
  }

  log("START", nodeId, `agent: ${node.agent}`)

  let result: AgentResult
  try {
    result = await invokeAgent(node, state)
  } catch (err) {
    log("ERROR", nodeId, String(err))
    const fallbackId = node.fallback ?? graph.fallback
    log("FALLBACK", nodeId, `→ ${fallbackId}`)
    return executeNode(fallbackId, nodeId, state)
  }

  // Post-guardrails — retry once with reason, then pause
  if (guardrails.post?.length) {
    const post = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice })
    if (!post.pass) {
      log("GUARD", nodeId, `post-guardrail failed: ${post.reason} — retrying`)

      // Inject guardrail feedback into context for the retry
      const prevInstruction = node.instruction ?? ""
      const retryNode: GraphNode = {
        ...node,
        instruction: `${prevInstruction}\n\nGUARDRAIL FEEDBACK: Your previous output was rejected. Reason: ${post.reason}\nFix the issue and try again.`,
      }

      try {
        result = await invokeAgent(retryNode, state)
      } catch (err) {
        log("ERROR", nodeId, `retry failed: ${String(err)}`)
        return pauseWithReason(state, nodeId, fromNodeId, `post-guardrail: ${post.reason} (retry also failed)`)
      }

      const post2 = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice })
      if (!post2.pass) {
        return pauseWithReason(state, nodeId, fromNodeId, `post-guardrail: ${post2.reason} (after retry)`)
      }
    }
  }

  const nextNodeId = node.options?.[result.choice]
  if (!nextNodeId) {
    log("INVALID", nodeId, `choice "${result.choice}" not declared — routing to fallback`)
    return executeNode(node.fallback ?? graph.fallback, nodeId, state)
  }

  log("CHOICE", nodeId, `→ ${result.choice} → ${nextNodeId}`)

  appendContext(context, nodeId, result.output)
  writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))

  return executeNode(nextNodeId, nodeId, state)
}

// ─── WORKFLOW LIBRARY ─────────────────────────────────────────────────────────

const LIBRARY_DIR = join(homedir(), ".supertinker", "workflows")

export function buildCatalog(): string {
  mkdirSync(LIBRARY_DIR, { recursive: true })
  const files = readdirSync(LIBRARY_DIR).filter(f => f.endsWith(".workflow.ts"))

  if (files.length === 0) return "No saved workflows in library."

  const entries: string[] = []
  for (const file of files) {
    try {
      const raw = readFileSync(join(LIBRARY_DIR, file), "utf8")
      const idMatch   = raw.match(/"id"\s*:\s*"([^"]+)"/)
      const descMatch = raw.match(/"description"\s*:\s*"([^"]+)"/)
      const nodeCount = (raw.match(/"id"\s*:/g) || []).length - 1  // subtract the top-level id
      const id   = idMatch?.[1]   ?? file
      const desc = descMatch?.[1] ?? "(no description)"
      entries.push(`- ${id}: ${desc} (${nodeCount} nodes) [${file}]`)
    } catch { /* skip unreadable files */ }
  }

  return `Saved workflows (${entries.length}):\n${entries.join("\n")}`
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function run({
  workflow,
  initialContext = {},
}: {
  workflow:        Workflow
  initialContext?: Context
}): Promise<void> {
  const { graph, registry } = workflow
  const runId  = `${workflow.id}-${Date.now()}`
  const runDir = join("/tmp/orchestrator", runId)
  mkdirSync(runDir, { recursive: true })

  const logFile = join(runDir, "orchestrator.log")
  const log     = makeLogger(logFile)

  // Persistent orchestrator log pane
  tmuxNewWindow(`orch-log`, `tail -f ${logFile}`)

  log("RUN", runId, workflow.description)
  log("RUN", runId, `graph: ${graph.id}  nodes: ${graph.nodes.length}`)
  log("RUN", runId, `run dir: ${runDir}`)

  // Fail fast if any [variable] references in node instructions are unresolvable
  validateTemplateVariables(graph, initialContext)

  const state: RunState = {
    runId,
    runDir,
    context: { ...initialContext },
    joinMap: new Map(),
    iterationCounts: new Map(),
    graph,
    registry,
    guardrails: workflow.guardrails ?? {},
    log,
  }

  await executeNode(graph.start, null, state)
}

export async function resume({
  workflow,
  runId,
  choice,
}: {
  workflow: Workflow
  runId:   string
  choice:  string
}): Promise<void> {
  const { graph, registry } = workflow
  const runDir    = join("/tmp/orchestrator", runId)
  const stateFile = join(runDir, "state.json")

  if (!existsSync(stateFile)) throw new Error(`No paused state found: ${stateFile}`)

  const paused: PausedState = JSON.parse(readFileSync(stateFile, "utf8"))
  const logFile = join(runDir, "orchestrator.log")
  const log     = makeLogger(logFile)

  const fromNode = graph.nodes.find(n => n.id === paused.nodeId)
  if (!fromNode?.options?.[choice]) {
    throw new Error(`Choice "${choice}" not valid for node "${paused.nodeId}". Options: ${Object.keys(fromNode?.options ?? {}).join(", ")}`)
  }

  log("RESUME", runId, `node: ${paused.nodeId}  choice: ${choice}`)

  const state: RunState = {
    runId,
    runDir,
    context: paused.context,
    joinMap: new Map(),
    iterationCounts: new Map(),
    graph,
    registry,
    guardrails: workflow.guardrails ?? {},
    log,
  }

  await executeNode(fromNode.options[choice], paused.nodeId, state)
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  const argv    = process.argv.slice(2)
  const command = argv[0]
  const get     = (flag: string) => argv[argv.indexOf(flag) + 1] as string | undefined

  if (command === "run") {
    const workflowPath = get("--workflow")
    const prompt       = get("--prompt")
    if (!workflowPath) {
      console.error("Usage: supertinker run --workflow <path> --prompt <text>")
      process.exit(1)
    }
    const { workflow } = await import(resolve(workflowPath))
    const initialContext: Context = { catalog: buildCatalog() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext })
    return
  }

  if (command === "resume") {
    const runId        = get("--run")
    const choice       = get("--choice")
    const workflowPath = get("--workflow")
    if (!runId || !choice || !workflowPath) {
      console.error("Usage: supertinker resume --run <runId> --choice <label> --workflow <path>")
      process.exit(1)
    }
    const { workflow } = await import(resolve(workflowPath))
    await resume({ workflow, runId, choice })
    return
  }

  console.log(`
supertinker — minimal agent orchestrator

Commands:
  run     --workflow <path> --prompt <text>
  resume  --run <runId> --choice <label> --workflow <path>

Example:
  tsx supertinker.ts run --workflow ./workflow.ts --prompt "Build a REST API"
  tsx supertinker.ts resume --run plan-develop-review-1234567890 --choice approved --workflow ./workflow.ts
  `)
}

// ─── TMUX AUTO-LAUNCH ────────────────────────────────────────────────────────

function ensureTmux(): boolean {
  if (tmuxRunning()) return true

  // Re-launch ourselves inside a new tmux session (detached)
  const args = process.argv.slice(1).map(a => `'${a}'`).join(" ")
  const cmd  = `${process.argv[0]} ${args}`
  const sess = `supertinker-${Date.now()}`

  try {
    const { execSync } = require("child_process")
    execSync(`tmux new-session -d -s "${sess}" "${cmd}"`, { stdio: "ignore" })
    console.log(`supertinker running in tmux session: ${sess}`)
    console.log(`  attach:  tmux attach -t ${sess}`)
    console.log(`  kill:    tmux kill-session -t ${sess}`)
    return false  // we're the outer process — tmux is running in background
  } catch {
    // tmux not installed or failed — run without it
    console.log("(tmux not available — running without panes)")
    return true
  }
}

// ─── ENTRYPOINT ───────────────────────────────────────────────────────────────

const isMain = process.argv[1] && (
  process.argv[1].endsWith("supertinker.ts") ||
  process.argv[1].endsWith("supertinker.js")
)

if (isMain) {
  if (ensureTmux()) {
    cli().catch(err => { console.error(err); process.exit(1) })
  }
}