#!/usr/bin/env tsx
/**
 * supertinker.ts — A minimal agent orchestrator
 *
 * Usage:
 *   tsx supertinker.ts run --prompt "Build a REST API"
 *   tsx supertinker.ts run --workflow meta --prompt "Build a REST API"
 *   tsx supertinker.ts resume --run <runId> --choice <label> --workflow <name|path>
 *   tsx supertinker.ts list
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync,
         readFileSync, writeFileSync, copyFileSync }            from "fs"
import { spawn, spawnSync }                                     from "child_process"
import { join, resolve }                                        from "path"
import { homedir }                                              from "os"

// ─── TYPES ────────────────────────────────────────────────────────────────────

export interface GraphNode {
  id:           string
  type?:        "fork" | "join" | "done" | "failed" | "paused" | "subworkflow"
  agent?:       string
  cwd?:         string
  slice?:       string[]
  instruction?: string
  systemPrompt?: string
  options?:     Record<string, string>
  fallback?:    string
  targets?:     string[]
  waits_for?:   string[]
  source?:      string
}

export interface Graph {
  id: string; start: string; fallback: string; labels: string[]; nodes: GraphNode[]
}

export interface AgentDefinition {
  command: string; model?: string; systemPrompt: string
}

export type AgentRegistry = Record<string, AgentDefinition>
export type Context       = Record<string, string>

export type GuardrailCheck = (ctx: {
  context: Context; nodeId: string; output?: string; choice?: string
}) => { pass: true } | { pass: false; reason: string }

export interface GuardrailRule {
  check: string; reason: string; nodeId?: string
}

export interface Guardrails {
  pre?:  (GuardrailCheck | GuardrailRule)[]
  post?: (GuardrailCheck | GuardrailRule)[]
  maxIterations?: number
}

export interface Workflow {
  id: string; description: string; graph: Graph; registry: AgentRegistry; guardrails?: Guardrails
}

interface AgentResult { output: string; choice: string }

export interface PausedState {
  runId: string; nodeId: string; context: Context; agentOutput: string; reason?: string
}

interface RunState {
  runId: string; runDir: string; context: Context
  joinMap: Map<string, Set<string>>; iterationCounts: Map<string, number>
  graph: Graph; registry: AgentRegistry; guardrails: Guardrails; log: Logger
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

function tmuxRunning(): boolean { return !!process.env.TMUX }

function tmux(action: "new-window" | "kill-window", name: string, cmd?: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    const args = action === "new-window" ? [action, "-n", safe, cmd!] : [action, "-t", safe]
    spawn("tmux", args, { detached: true, stdio: "ignore" }).unref()
  } catch { /* not in tmux */ }
}

// ─── CONTEXT ──────────────────────────────────────────────────────────────────

function sliceContext(ctx: Context, keys?: string[]): Context {
  if (!keys) return ctx
  return Object.fromEntries(keys.filter(k => k in ctx).map(k => [k, ctx[k]]))
}

function renderUserPrompt(ctx: Context, instruction?: string): string {
  const sections = Object.entries(ctx).map(([k, v]) => `[${k}]\n${v}`).join("\n\n")
  return instruction ? `${instruction}\n\n${sections}` : sections
}

function validateTemplateVariables(graph: Graph, initialContext: Context): void {
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
    throw new Error(`Workflow "${graph.id}" has unresolved template variables.\nAdd them to initialContext:\n${details}`)
  }
}

// ─── SYSTEM PROMPT ────────────────────────────────────────────────────────────

function buildSystemPrompt(registry: AgentRegistry, node: GraphNode): string {
  const def = registry[node.agent!]
  const optionsPrompt = node.options
    ? `You MUST end your response with this exact sentinel block, selecting one option:\n\n---CHOICE---\n<label>\n---END---\n\nAvailable options: ${Object.keys(node.options).join(" | ")}\n\nDo not invent options. Do not omit the sentinel block.`
    : undefined
  return [def.systemPrompt, node.systemPrompt, optionsPrompt].filter(Boolean).join("\n\n")
}

// ─── PROVIDERS ───────────────────────────────────────────────────────────────

export interface ProviderContext {
  userPrompt: string; systemPrompt: string; options: string[]
  cwd: string; model?: string; logFile: string
}
export type ProviderInvoke = (ctx: ProviderContext) => Promise<AgentResult>

const BUILTIN_DIR = resolve(join(new URL(import.meta.url).pathname, ".."))
const USER_DIR    = join(homedir(), ".supertinker")
const providerCache = new Map<string, ProviderInvoke>()

function findFile(name: string, subdir: string, ext: string): string | null {
  for (const base of [BUILTIN_DIR, USER_DIR]) {
    for (const e of ext.split("|")) {
      const p = join(base, subdir, `${name}.${e}`)
      if (existsSync(p)) return p
    }
  }
  return null
}

async function loadProvider(name: string): Promise<ProviderInvoke> {
  if (providerCache.has(name)) return providerCache.get(name)!
  const path = findFile(name, "providers", "ts|js")
  if (!path) throw new Error(`Provider "${name}" not found in ${BUILTIN_DIR}/providers or ${USER_DIR}/providers`)
  const mod = await import(path)
  const invoke = mod.invoke ?? mod.default?.invoke
  if (typeof invoke !== "function") throw new Error(`Provider "${name}" must export invoke(ctx)`)
  providerCache.set(name, invoke)
  return invoke
}

// ─── AGENT INVOCATION ─────────────────────────────────────────────────────────

async function invokeAgent(node: GraphNode, state: RunState): Promise<AgentResult> {
  const def        = state.registry[node.agent!]
  const sliced     = sliceContext(state.context, node.slice)
  const userPrompt = renderUserPrompt(sliced, node.instruction)
  const sysPrompt  = buildSystemPrompt(state.registry, node)
  const cwd        = resolve(node.cwd ?? process.cwd())
  const logFile    = join(state.runDir, `${node.id}.log`)

  tmux("new-window", `node-${node.id}`, `tail -f ${logFile}`)
  try {
    const invoke = await loadProvider(def.command)
    return await invoke({ userPrompt, systemPrompt: sysPrompt, options: Object.keys(node.options ?? {}), cwd, model: def.model, logFile })
  } finally {
    await new Promise(r => setTimeout(r, 800))
    tmux("kill-window", `node-${node.id}`)
  }
}

// ─── GUARDRAILS ──────────────────────────────────────────────────────────────

function evalGuardrail(
  g: GuardrailCheck | GuardrailRule,
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): { pass: true } | { pass: false; reason: string } {
  if (typeof g === "function") return g(ctx)
  // GuardrailRule — declarative JS expression
  if (g.nodeId && g.nodeId !== ctx.nodeId) return { pass: true }
  try {
    const { output = "", choice = "", nodeId, context } = ctx
    const pass = new Function("output", "choice", "nodeId", "context",
      `"use strict"; return !!(${g.check})`)(output, choice, nodeId, context)
    return pass ? { pass: true } : { pass: false, reason: g.reason }
  } catch (err) { return { pass: false, reason: `guardrail eval error: ${err}` } }
}

function runGuardrails(
  checks: (GuardrailCheck | GuardrailRule)[],
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): { pass: true } | { pass: false; reason: string } {
  for (const check of checks) {
    const result = evalGuardrail(check, ctx)
    if (!result.pass) return result
  }
  return { pass: true }
}

function writePause(state: RunState, nodeId: string, fromNodeId: string | null, reason?: string): void {
  const { runDir, context, log } = state
  const paused: PausedState = {
    runId: state.runId, nodeId: fromNodeId ?? nodeId, context,
    agentOutput: context[fromNodeId ?? ""] ?? "", reason,
  }
  writeFileSync(join(runDir, "state.json"), JSON.stringify(paused, null, 2))
  writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))
  if (reason) log("GUARD", nodeId, reason)
  log("PAUSED", nodeId, `state → ${join(runDir, "state.json")}`)
  log("PAUSED", nodeId, `resume: supertinker resume --run ${state.runId} --choice <label> --workflow <path>`)
}

// ─── ORCHESTRATOR CORE ────────────────────────────────────────────────────────

async function executeNode(nodeId: string, fromNodeId: string | null, state: RunState): Promise<void> {
  const { graph, context, joinMap, runDir, log } = state
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) throw new Error(`Node not found: "${nodeId}"`)

  // ── Terminals ────────────────────────────────────────────────────────────
  if (node.type === "done")   { log("DONE", "graph", "✓ completed"); return }
  if (node.type === "failed") { log("FAILED", "graph", "✗ failed"); throw new Error("Graph reached failed terminal") }
  if (node.type === "paused") { writePause(state, nodeId, fromNodeId); return }

  // ── Fork ─────────────────────────────────────────────────────────────────
  if (node.type === "fork") {
    log("FORK", nodeId, `→ [${node.targets!.join(", ")}]`)
    await Promise.all(node.targets!.map(t => executeNode(t, nodeId, state)))
    return
  }

  // ── Join ─────────────────────────────────────────────────────────────────
  if (node.type === "join") {
    if (!joinMap.has(nodeId)) joinMap.set(nodeId, new Set())
    const done = joinMap.get(nodeId)!
    if (fromNodeId) done.add(fromNodeId)
    log("JOIN", nodeId, `${done.size}/${node.waits_for!.length} complete`)
    if (done.size < node.waits_for!.length) return
  }

  // ── Subworkflow ──────────────────────────────────────────────────────────
  if (node.type === "subworkflow") {
    const raw = context[node.source!]
    if (!raw) { log("ERROR", nodeId, `source "${node.source}" not in context`); return executeNode(node.fallback ?? graph.fallback, nodeId, state) }

    let inner: Workflow
    try { inner = JSON.parse(raw) }
    catch (err) { log("ERROR", nodeId, `bad workflow JSON: ${err}`); return executeNode(node.fallback ?? graph.fallback, nodeId, state) }

    // Save as reusable .workflow.ts
    const importPath = resolve("supertinker.ts").replace(/\.ts$/, "")
    const tsContent = `import type { Workflow } from "${importPath}";\n\nexport const workflow: Workflow = ${JSON.stringify(inner, null, 2)};\n`
    const workflowFile = join(runDir, `${inner.id}.workflow.ts`)
    writeFileSync(workflowFile, tsContent)
    log("SUBWORK", nodeId, `saved → ${workflowFile}`)
    log("SUBWORK", nodeId, `executing "${inner.id}" (${inner.graph.nodes.length} nodes)`)

    const innerRunDir = join(runDir, `sub-${inner.id}`)
    mkdirSync(innerRunDir, { recursive: true })

    const innerContext: Context = {}
    for (const key of node.slice ?? Object.keys(context))
      if (key in context && key !== node.source) innerContext[key] = context[key]

    // Propagate cwd to inner nodes
    if (node.cwd) { const cwd = resolve(node.cwd); for (const n of inner.graph.nodes) { if (!n.cwd && n.agent) n.cwd = cwd } }

    const innerState: RunState = {
      runId: `${state.runId}/${inner.id}`, runDir: innerRunDir,
      context: innerContext, joinMap: new Map(), iterationCounts: new Map(),
      graph: inner.graph, registry: inner.registry,
      guardrails: {
        maxIterations: inner.guardrails?.maxIterations ?? state.guardrails.maxIterations,
        pre:  [...(state.guardrails.pre ?? []),  ...(inner.guardrails?.pre ?? [])],
        post: [...(state.guardrails.post ?? []), ...(inner.guardrails?.post ?? [])],
      },
      log: makeLogger(join(innerRunDir, "orchestrator.log")),
    }

    try { await executeNode(inner.graph.start, null, innerState) }
    catch (err) { log("ERROR", nodeId, `subworkflow failed: ${err}`); return executeNode(node.fallback ?? graph.fallback, nodeId, state) }

    context[nodeId] = JSON.stringify(innerState.context)
    writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))

    // Save to library
    const libDir = join(USER_DIR, "workflows"); mkdirSync(libDir, { recursive: true })
    copyFileSync(workflowFile, join(libDir, `${inner.id}.workflow.ts`))
    log("SUBWORK", nodeId, `library → ${join(libDir, `${inner.id}.workflow.ts`)}`)
    log("SUBWORK", nodeId, `completed`)

    const next = node.options?.["done"]
    if (next) return executeNode(next, nodeId, state)
    return
  }

  // ── Standard node ────────────────────────────────────────────────────────
  const { guardrails, iterationCounts } = state
  const count = (iterationCounts.get(nodeId) ?? 0) + 1
  iterationCounts.set(nodeId, count)

  if (guardrails.maxIterations && count > guardrails.maxIterations)
    return writePause(state, nodeId, fromNodeId, `node "${nodeId}" exceeded max iterations (${guardrails.maxIterations})`)

  if (guardrails.pre?.length) {
    const pre = runGuardrails(guardrails.pre, { context, nodeId })
    if (!pre.pass) return writePause(state, nodeId, fromNodeId, `pre-guardrail: ${pre.reason}`)
  }

  log("START", nodeId, `agent: ${node.agent}`)

  let result: AgentResult
  try { result = await invokeAgent(node, state) }
  catch (err) { log("ERROR", nodeId, String(err)); return executeNode(node.fallback ?? graph.fallback, nodeId, state) }

  // Post-guardrails — retry once, then pause
  if (guardrails.post?.length) {
    const post = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice })
    if (!post.pass) {
      log("GUARD", nodeId, `${post.reason} — retrying`)
      const retryNode = { ...node, instruction: `${node.instruction ?? ""}\n\nGUARDRAIL FEEDBACK: ${post.reason}\nFix the issue and try again.` }
      try { result = await invokeAgent(retryNode, state) }
      catch (err) { return writePause(state, nodeId, fromNodeId, `post-guardrail: ${post.reason} (retry failed)`) }
      const post2 = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice })
      if (!post2.pass) return writePause(state, nodeId, fromNodeId, `post-guardrail: ${post2.reason} (after retry)`)
    }
  }

  const nextNodeId = node.options?.[result.choice]
  if (!nextNodeId) { log("INVALID", nodeId, `choice "${result.choice}" not declared`); return executeNode(node.fallback ?? graph.fallback, nodeId, state) }

  log("CHOICE", nodeId, `→ ${result.choice} → ${nextNodeId}`)
  context[nodeId] = result.output
  writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))
  return executeNode(nextNodeId, nodeId, state)
}

// ─── WORKFLOW LIBRARY ─────────────────────────────────────────────────────────

export function buildCatalog(): string {
  const entries: string[] = []
  for (const [dir, source] of [[join(BUILTIN_DIR, "workflows"), "built-in"], [join(USER_DIR, "workflows"), "library"]] as const) {
    try { mkdirSync(dir, { recursive: true }) } catch {}
    for (const file of (existsSync(dir) ? readdirSync(dir) : []).filter((f: string) => f.endsWith(".workflow.ts"))) {
      try {
        const raw = readFileSync(join(dir, file), "utf8")
        const id   = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)?.[1] ?? file
        const desc = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)?.[1] ?? "(no description)"
        const nodes = (raw.match(/(?:"id"|id)\s*:/g) || []).length - 1
        entries.push(`- ${id}: ${desc} (${nodes} nodes) [${source}: ${file}]`)
      } catch {}
    }
  }
  return entries.length === 0 ? "No workflows available." : `Available workflows (${entries.length}):\n${entries.join("\n")}`
}

export function resolveWorkflow(name: string): string | null {
  const file = name.endsWith(".workflow.ts") ? name : `${name}.workflow.ts`
  for (const base of [BUILTIN_DIR, USER_DIR]) {
    const p = join(base, "workflows", file)
    if (existsSync(p)) return p
  }
  return null
}

// ─── PUBLIC API ───────────────────────────────────────────────────────────────

export async function run({ workflow, initialContext = {} }: { workflow: Workflow; initialContext?: Context }): Promise<void> {
  const { graph, registry } = workflow
  const runId  = `${workflow.id}-${Date.now()}`
  const runDir = join("/tmp/orchestrator", runId)
  mkdirSync(runDir, { recursive: true })

  const log = makeLogger(join(runDir, "orchestrator.log"))
  tmux("new-window", "orch-log", `tail -f ${join(runDir, "orchestrator.log")}`)

  log("RUN", runId, workflow.description)
  log("RUN", runId, `graph: ${graph.id}  nodes: ${graph.nodes.length}  dir: ${runDir}`)

  validateTemplateVariables(graph, initialContext)

  await executeNode(graph.start, null, {
    runId, runDir, context: { ...initialContext }, joinMap: new Map(),
    iterationCounts: new Map(), graph, registry, guardrails: workflow.guardrails ?? {}, log,
  })
}

export async function resume({ workflow, runId, choice }: { workflow: Workflow; runId: string; choice: string }): Promise<void> {
  const { graph, registry } = workflow
  const runDir = join("/tmp/orchestrator", runId)
  if (!existsSync(join(runDir, "state.json"))) throw new Error(`No paused state: ${runDir}/state.json`)

  const paused: PausedState = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
  const log = makeLogger(join(runDir, "orchestrator.log"))
  const fromNode = graph.nodes.find(n => n.id === paused.nodeId)
  if (!fromNode?.options?.[choice]) throw new Error(`Choice "${choice}" not valid for "${paused.nodeId}". Options: ${Object.keys(fromNode?.options ?? {})}`)

  log("RESUME", runId, `node: ${paused.nodeId}  choice: ${choice}`)

  await executeNode(fromNode.options[choice], paused.nodeId, {
    runId, runDir, context: paused.context, joinMap: new Map(),
    iterationCounts: new Map(), graph, registry, guardrails: workflow.guardrails ?? {}, log,
  })
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

async function cli(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd  = argv[0]
  const get  = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

  if (cmd === "run") {
    const workflowRef  = get("--workflow") ?? "meta"
    const prompt       = get("--prompt")
    const workflowPath = resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    const initialContext: Context = { catalog: buildCatalog() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext })
    return
  }

  if (cmd === "resume") {
    const runId = get("--run"), choice = get("--choice"), workflowRef = get("--workflow")
    if (!runId || !choice || !workflowRef) { console.error("Usage: supertinker resume --run <id> --choice <label> --workflow <name|path>"); process.exit(1) }
    const { workflow } = await import(resolveWorkflow(workflowRef) ?? resolve(workflowRef))
    await resume({ workflow, runId, choice })
    return
  }

  if (cmd === "list") { console.log(buildCatalog()); return }

  console.log(`supertinker — minimal agent orchestrator

Commands:
  run     [--workflow <name|path>] --prompt <text>   (default: meta)
  resume  --run <runId> --choice <label> --workflow <name|path>
  list    show available workflows

Examples:
  tsx supertinker.ts run --prompt "Build a REST API"
  tsx supertinker.ts run --workflow meta --prompt "Build a REST API"
  tsx supertinker.ts list`)
}

// ─── TMUX AUTO-LAUNCH ────────────────────────────────────────────────────────

function ensureTmux(): boolean {
  if (tmuxRunning()) return true
  const args = process.argv.slice(1).map(a => `'${a}'`).join(" ")
  const sess = `supertinker-${Date.now()}`
  try {
    spawnSync("tmux", ["new-session", "-d", "-s", sess, `${process.argv[0]} ${args}`], { stdio: "ignore" })
    console.log(`supertinker running in tmux session: ${sess}`)
    console.log(`  attach:  tmux attach -t ${sess}`)
    console.log(`  kill:    tmux kill-session -t ${sess}`)
    return false
  } catch {
    console.log("(tmux not available — running without panes)")
    return true
  }
}

// ─── ENTRYPOINT ───────────────────────────────────────────────────────────────

const isMain = process.argv[1]?.endsWith("supertinker.ts") || process.argv[1]?.endsWith("supertinker.js")

if (isMain) {
  const cmd = process.argv[2]
  if (!cmd || cmd === "list" || cmd === "help") cli().catch(err => { console.error(err); process.exit(1) })
  else if (ensureTmux()) cli().catch(err => { console.error(err); process.exit(1) })
}
