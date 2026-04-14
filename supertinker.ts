#!/usr/bin/env tsx
/**
 * supertinker.ts — A minimal agent orchestrator (~420 lines)
 *
 * Usage:
 *   tsx supertinker.ts run    --graph ./graph.ts --registry ./registry.ts
 *   tsx supertinker.ts resume --run <runId> --choice <label> --graph ./graph.ts --registry ./registry.ts
 */

import { appendFileSync, existsSync, mkdirSync,
         readdirSync, readFileSync, writeFileSync }           from "fs"
import { spawn }                                              from "child_process"
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

// ─── PROVIDERS ───────────────────────────────────────────────────────────────

export interface ProviderContext {
  userPrompt:   string
  systemPrompt: string
  options:      string[]    // available choice labels
  cwd:          string
  model?:       string
  logFile:      string
}

export type ProviderInvoke = (ctx: ProviderContext) => Promise<AgentResult>

const BUILTIN_PROVIDERS_DIR = resolve(join(new URL(import.meta.url).pathname, "..", "providers"))
const USER_PROVIDERS_DIR    = join(homedir(), ".supertinker", "providers")
const providerCache = new Map<string, ProviderInvoke>()

function findProvider(name: string): string | null {
  for (const dir of [BUILTIN_PROVIDERS_DIR, USER_PROVIDERS_DIR]) {
    const ts = join(dir, `${name}.ts`)
    const js = join(dir, `${name}.js`)
    if (existsSync(ts)) return ts
    if (existsSync(js)) return js
  }
  return null
}

async function loadProvider(name: string): Promise<ProviderInvoke> {
  if (providerCache.has(name)) return providerCache.get(name)!

  const path = findProvider(name)
  if (!path) throw new Error(`Provider "${name}" not found. Searched: ${BUILTIN_PROVIDERS_DIR}, ${USER_PROVIDERS_DIR}`)

  const mod = await import(path)
  const invoke = mod.invoke ?? mod.default?.invoke
  if (typeof invoke !== "function") {
    throw new Error(`Provider "${name}" must export an invoke(ctx) function`)
  }

  providerCache.set(name, invoke)
  return mod.invoke
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
    const invoke = await loadProvider(def.command)
    return await invoke({
      userPrompt,
      systemPrompt: sysPrompt,
      options: Object.keys(node.options ?? {}),
      cwd,
      model: def.model,
      logFile,
    })
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

const BUILTIN_WORKFLOWS_DIR = resolve(join(new URL(import.meta.url).pathname, "..", "workflows"))
const USER_WORKFLOWS_DIR    = join(homedir(), ".supertinker", "workflows")

function scanWorkflowDir(dir: string): string[] {
  try {
    mkdirSync(dir, { recursive: true })
    return readdirSync(dir).filter(f => f.endsWith(".workflow.ts"))
  } catch { return [] }
}

export function buildCatalog(): string {
  const entries: string[] = []

  for (const [dir, source] of [[BUILTIN_WORKFLOWS_DIR, "built-in"], [USER_WORKFLOWS_DIR, "library"]] as const) {
    for (const file of scanWorkflowDir(dir)) {
      try {
        const raw = readFileSync(join(dir, file), "utf8")
        const idMatch   = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)
        const descMatch = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)
        const nodeCount = (raw.match(/(?:"id"|id)\s*:/g) || []).length - 1
        const id   = idMatch?.[1]   ?? file
        const desc = descMatch?.[1] ?? "(no description)"
        entries.push(`- ${id}: ${desc} (${nodeCount} nodes) [${source}: ${file}]`)
      } catch { /* skip unreadable files */ }
    }
  }

  if (entries.length === 0) return "No workflows available."
  return `Available workflows (${entries.length}):\n${entries.join("\n")}`
}

export function resolveWorkflow(name: string): string | null {
  for (const dir of [BUILTIN_WORKFLOWS_DIR, USER_WORKFLOWS_DIR]) {
    const path = join(dir, name.endsWith(".workflow.ts") ? name : `${name}.workflow.ts`)
    if (existsSync(path)) return path
  }
  return null
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
    const workflowRef  = get("--workflow") ?? "meta"
    const prompt       = get("--prompt")
    // Resolve: try as built-in/library name first, then as file path
    const workflowPath = resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    const initialContext: Context = { catalog: buildCatalog() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext })
    return
  }

  if (command === "resume") {
    const runId        = get("--run")
    const choice       = get("--choice")
    const workflowRef  = get("--workflow")
    if (!runId || !choice || !workflowRef) {
      console.error("Usage: supertinker resume --run <runId> --choice <label> --workflow <name|path>")
      process.exit(1)
    }
    const workflowPath = resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    await resume({ workflow, runId, choice })
    return
  }

  if (command === "list") {
    console.log(buildCatalog())
    return
  }

  console.log(`
supertinker — minimal agent orchestrator

Commands:
  run     --workflow <name|path> --prompt <text>
  resume  --run <runId> --choice <label> --workflow <name|path>
  list    show available workflows (built-in + library)

Example:
  tsx supertinker.ts run --workflow meta --prompt "Build a REST API"
  tsx supertinker.ts run --workflow ./my-workflow.ts --prompt "Fix the bug"
  tsx supertinker.ts list
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
  const cmd = process.argv[2]
  // Commands that don't need tmux
  if (cmd === "list" || cmd === "help" || !cmd) {
    cli().catch(err => { console.error(err); process.exit(1) })
  } else if (ensureTmux()) {
    cli().catch(err => { console.error(err); process.exit(1) })
  }
}