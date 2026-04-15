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
         readFileSync, writeFileSync }                          from "fs"
import { spawnSync }                                             from "child_process"
import { join, resolve }                                        from "path"
import { homedir }                                              from "os"
import { createRequire }                                        from "module"

// ─── TYPES

export interface GraphNode {
  id:           string
  type?:        "fork" | "join" | "done" | "failed" | "paused" | "subworkflow"
  agent?:       string
  cwd?:         string
  slice?:       string[]
  instruction?: string
  systemPrompt?: string
  options?:     Record<string, string>
  timeout?:     number     // agent invocation timeout in ms (default: 600000 = 10 min)
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

export interface AgentResult { output: string; choice: string; transcriptPath?: string }

export interface PausedState {
  runId: string; nodeId: string; context: Context; agentOutput: string; reason?: string
  iterationCounts?: Record<string, number>
}

// ─── STORAGE ADAPTER

export interface StorageAdapter {
  createRun(runId: string): Promise<string>               // returns runDir (or equivalent path)
  saveContext(runDir: string, context: Context): Promise<void>
  loadContext(runDir: string): Promise<Context>
  savePause(runDir: string, state: PausedState): Promise<void>
  loadPause(runDir: string): Promise<PausedState>
  pauseExists(runDir: string): Promise<boolean>
  appendLog(runDir: string, line: string): Promise<void>
  saveFile(runDir: string, name: string, content: string): Promise<void>
  saveWorkflow(id: string, content: string): Promise<void> // persist generated workflow to library
  logPath(runDir: string, nodeId: string): string          // returns path for provider logFile
  resolveWorkflow(name: string): Promise<string | null>
  listWorkflows(): Promise<Array<{ id: string; description: string; file: string; source: string }>>
}

const BUILTIN_DIR = resolve(join(new URL(import.meta.url).pathname, ".."))
const USER_DIR    = join(homedir(), ".supertinker")
const PROJECT_DIR = join(process.cwd(), ".supertinker")
const SEARCH_DIRS = [PROJECT_DIR, USER_DIR, BUILTIN_DIR]  // project-local wins

export const filesystemStorage: StorageAdapter = {
  async createRun(runId) {
    const dir = join("/tmp/orchestrator", runId)
    mkdirSync(dir, { recursive: true })
    return dir
  },
  async saveContext(runDir, context) {
    writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2))
  },
  async loadContext(runDir) {
    return JSON.parse(readFileSync(join(runDir, "context.json"), "utf8"))
  },
  async savePause(runDir, state) {
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2))
  },
  async loadPause(runDir) {
    return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
  },
  async pauseExists(runDir) {
    return existsSync(join(runDir, "state.json"))
  },
  async appendLog(runDir, line) {
    appendFileSync(join(runDir, "orchestrator.log"), line + "\n")
  },
  logPath(runDir, nodeId) {
    return join(runDir, `${nodeId}.log`)
  },
  async saveFile(runDir, name, content) {
    writeFileSync(join(runDir, name), content)
  },
  async saveWorkflow(id, content) {
    const dir = join(USER_DIR, "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.workflow.ts`), content)
  },
  async resolveWorkflow(name) {
    const file = name.endsWith(".workflow.ts") ? name : `${name}.workflow.ts`
    for (const base of SEARCH_DIRS) {
      const p = join(base, "workflows", file)
      if (existsSync(p)) return p
    }
    return null
  },
  async listWorkflows() {
    const entries: Array<{ id: string; description: string; file: string; source: string }> = []
    const sources: Array<[string, string]> = [
      [join(PROJECT_DIR, "workflows"), "project"],
      [join(USER_DIR, "workflows"), "library"],
      [join(BUILTIN_DIR, "workflows"), "built-in"],
    ]
    for (const [dir, source] of sources) {
      let files: string[]
      try { files = readdirSync(dir).filter((f: string) => f.endsWith(".workflow.ts")) } catch { continue }
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), "utf8")
          const id   = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)?.[1] ?? file
          const description = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)?.[1] ?? "(no description)"
          entries.push({ id, description, file, source })
        } catch {}
      }
    }
    return entries
  },
}

export interface ProviderOverrides {
  provider?: string; model?: string
}

interface RunState {
  runId: string; runDir: string; context: Context
  joinMap: Map<string, Set<string>>; iterationCounts: Map<string, number>
  graph: Graph; registry: AgentRegistry; guardrails: Guardrails; hooks: HookIndex
  storage: StorageAdapter; overrides: ProviderOverrides
}

// ─── HOOKS

export type HookEventName =
  | "RunStart" | "RunEnd"
  | "PreAgent" | "PostAgent" | "PreProvider"
  | "Paused"   | "Resumed"
  | "ForkStart" | "ForkJoin"
  | "GuardrailFail"
  | "SubworkflowStart" | "SubworkflowEnd"
  | "Error"

export interface HookEventBase {
  event:     HookEventName
  runId:     string
  runDir:    string
  context:   Context
  timestamp: number
}

interface HookEventMap {
  RunStart:         { workflow: Workflow; initialContext: Context }
  RunEnd:           { terminal: "done" | "failed"; finalContext: Context }
  PreAgent:         { nodeId: string; agent: string; provider: string; userPrompt: string; systemPrompt: string; slicedContext: Context }
  PostAgent:        { nodeId: string; agent: string; provider: string; result: AgentResult; transcriptPath?: string }
  PreProvider:      { nodeId: string; agent: string; provider: string; userPrompt: string; systemPrompt: string; cwd: string; model?: string; logFile: string }
  Paused:           { nodeId: string; reason?: string; stateFile: string }
  Resumed:          { nodeId: string; choice: string }
  ForkStart:        { nodeId: string; targets: string[] }
  ForkJoin:         { nodeId: string; joinedFrom: string[] }
  GuardrailFail:    { nodeId: string; phase: "pre" | "post"; reason: string }
  SubworkflowStart: { nodeId: string; innerWorkflow: Workflow }
  SubworkflowEnd:   { nodeId: string; innerContext: Context }
  Error:            { nodeId: string; error: string; fallbackNodeId?: string }
}

export type HookEvent = { [K in HookEventName]: HookEventBase & { event: K } & HookEventMap[K] }[HookEventName]

export type HookDirective =
  | { action: "continue" }
  | { action: "skip" }
  | { action: "pause";    reason: string }
  | { action: "redirect"; targetNodeId: string }
  | { action: "abort";    reason: string }

export interface Hook {
  name:         string
  description?: string
  events:       HookEventName[]
  parallel?:    boolean    // default: true
  priority?:    number     // default: 50, 0 = highest
  timeout?:     number     // default: 30000 ms
  handler:      (event: HookEvent) => Promise<HookDirective>
}

export type HookIndex = Map<HookEventName, Hook[]>

// ─── CONTEXT

function sliceContext(ctx: Context, keys?: string[]): Context {
  if (!keys) return ctx
  return Object.fromEntries(keys.filter(k => k in ctx).map(k => [k, ctx[k]]))
}

function renderUserPrompt(ctx: Context, instruction?: string): string {
  const sections = Object.entries(ctx).map(([k, v]) => `[${k}]\n${v}`).join("\n\n")
  return instruction ? `${instruction}\n\n${sections}` : sections
}


function resolveFallback(node: GraphNode, graph: Graph): string {
  return node.fallback ?? graph.fallback
}

// saveContext/savePause delegate to state.storage when available, fall back to filesystem
async function saveContext(state: RunState): Promise<void> {
  await state.storage.saveContext(state.runDir, state.context)
}

// ─── SYSTEM PROMPT

function buildSystemPrompt(registry: AgentRegistry, node: GraphNode): string {
  const def = registry[node.agent!]
  const optionsPrompt = node.options
    ? `You MUST end your response with this exact sentinel block, selecting one option:\n\n---CHOICE---\n<label>\n---END---\n\nAvailable options: ${Object.keys(node.options).join(" | ")}\n\nDo not invent options. Do not omit the sentinel block.`
    : undefined
  return [def.systemPrompt, node.systemPrompt, optionsPrompt].filter(Boolean).join("\n\n")
}

// ─── PROVIDERS

export interface ProviderContext {
  userPrompt: string; systemPrompt: string; options: string[]
  cwd: string; model?: string; logFile: string
}
export type ProviderInvoke = (ctx: ProviderContext) => Promise<AgentResult>

const providerCache = new Map<string, ProviderInvoke>()

function findFile(name: string, subdir: string, ext: string): string | null {
  for (const base of SEARCH_DIRS) {
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
  if (!path) throw new Error(`Provider "${name}" not found in any search path: ${SEARCH_DIRS.map(d => join(d, "providers")).join(", ")}`)
  const mod = await import(path)
  const invoke = mod.invoke ?? mod.default?.invoke
  if (typeof invoke !== "function") throw new Error(`Provider "${name}" must export invoke(ctx)`)
  providerCache.set(name, invoke)
  return invoke
}

export async function loadStorage(): Promise<StorageAdapter> {
  const path = findFile("storage", "storage", "ts|js")
  if (!path) return filesystemStorage
  const mod = await import(path)
  const adapter = mod.storage ?? mod.default?.storage
  if (!adapter) return filesystemStorage
  return { ...filesystemStorage, ...adapter }  // merge: custom overrides only what it defines
}

// ─── HOOK SYSTEM

const VALID_EVENTS = new Set<HookEventName>([
  "RunStart", "RunEnd", "PreAgent", "PostAgent", "PreProvider", "Paused", "Resumed",
  "ForkStart", "ForkJoin", "GuardrailFail", "SubworkflowStart", "SubworkflowEnd", "Error",
])

const DIRECTIVE_RANK: Record<string, number> = {
  abort: 5, pause: 4, redirect: 3, skip: 2, continue: 1,
}

const DIRECTIVE_SUPPORT: Record<string, Set<HookEventName>> = {
  abort:    new Set(VALID_EVENTS),
  pause:    new Set(["PreAgent", "PreProvider", "PostAgent", "GuardrailFail", "SubworkflowStart"]),
  redirect: new Set(["PreAgent", "PreProvider", "PostAgent"]),
  skip:     new Set(["PreAgent", "PreProvider"]),
  continue: new Set(VALID_EVENTS),
}

function bootstrapLog(runDir: string, msg: string): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] BOOT    ${"hooks".padEnd(22)} ${msg}`
  appendFileSync(join(runDir, "orchestrator.log"), line + "\n")
  process.stdout.write(line + "\n")
}

async function loadHooks(runDir: string): Promise<HookIndex> {
  const index: HookIndex = new Map()
  for (const name of VALID_EVENTS) index.set(name, [])

  const dirs = SEARCH_DIRS.map(d => join(d, "hooks"))
  const loaded: string[] = []

  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const files = readdirSync(dir).filter((f: string) => f.endsWith(".ts") || f.endsWith(".js"))

    for (const file of files) {
      const path = join(dir, file)
      try {
        const mod = await import(path)
        const h = mod.hook ?? mod.default?.hook
        if (!h || typeof h.handler !== "function" || !h.name || !Array.isArray(h.events) || h.events.length === 0) {
          bootstrapLog(runDir, `WARN: skipping ${file} — invalid hook export`)
          continue
        }

        const hook: Hook = {
          name:     h.name,
          description: h.description,
          events:   h.events.filter((e: string) => VALID_EVENTS.has(e as HookEventName)) as HookEventName[],
          parallel: h.parallel ?? true,
          priority: h.priority ?? 50,
          timeout:  h.timeout ?? 30000,
          handler:  h.handler,
        }

        if (hook.events.length === 0) {
          bootstrapLog(runDir, `WARN: skipping ${file} — no valid events`)
          continue
        }

        for (const evt of hook.events) {
          index.get(evt)!.push(hook)
        }
        loaded.push(`${hook.name} (${hook.events.join(", ")})`)
      } catch (err) {
        bootstrapLog(runDir, `WARN: failed to load ${file}: ${err}`)
      }
    }
  }

  for (const hooks of index.values()) {
    hooks.sort((a, b) => a.priority! - b.priority!)
  }

  if (loaded.length > 0) bootstrapLog(runDir, `loaded: ${loaded.join(", ")}`)
  else bootstrapLog(runDir, "no hooks found")

  return index
}

async function emitHook(
  event: HookEventName,
  payload: Record<string, unknown>,
  state: RunState,
): Promise<HookDirective> {
  const hooks = state.hooks.get(event)
  if (!hooks || hooks.length === 0) return { action: "continue" }

  const isMutable = event === "PreAgent" || event === "PostAgent"
  const eventObj = {
    event,
    runId:     state.runId,
    runDir:    state.runDir,
    context:   isMutable ? state.context : Object.freeze({ ...state.context }),
    timestamp: Date.now(),
    ...payload,
  } as HookEvent

  const directives: Array<{ directive: HookDirective; priority: number }> = []

  const runOne = async (hook: Hook): Promise<void> => {
    try {
      const result = await Promise.race([
        hook.handler(eventObj),
        new Promise<HookDirective>((_, rej) => setTimeout(() => rej(new Error("timeout")), hook.timeout ?? 30000)),
      ])

      let directive: HookDirective = result
      if (result.action !== "continue") {
        const supported = DIRECTIVE_SUPPORT[result.action]
        if (!supported?.has(event)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: "${result.action}" not supported for ${event}, treating as continue\n`)
          directive = { action: "continue" }
        } else if (result.action === "redirect") {
          const rd = result as { action: "redirect"; targetNodeId: string }
          if (!state.graph.nodes.some(n => n.id === rd.targetNodeId)) {
            process.stderr.write(`HOOK-WARN ${hook.name}: redirect target "${rd.targetNodeId}" not found, treating as continue\n`)
            directive = { action: "continue" }
          }
        }
      }
      directives.push({ directive, priority: hook.priority ?? 50 })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      process.stderr.write(`HOOK-ERR ${hook.name} ${event}: ${msg}\n`)
      try { appendFileSync(join(state.runDir, "orchestrator.log"), `HOOK-ERR ${hook.name} ${event}: ${msg}\n`) } catch {}
      directives.push({ directive: { action: "continue" }, priority: hook.priority ?? 50 })
    }
  }

  const sequential = hooks.filter(h => h.parallel === false)
  for (const hook of sequential) await runOne(hook)

  const parallel = hooks.filter(h => h.parallel !== false)
  if (parallel.length > 0) await Promise.all(parallel.map(runOne))

  let winner: { directive: HookDirective; priority: number } = { directive: { action: "continue" }, priority: 100 }
  for (const d of directives) {
    const dRank = DIRECTIVE_RANK[d.directive.action] ?? 1
    const wRank = DIRECTIVE_RANK[winner.directive.action] ?? 1
    if (dRank > wRank || (dRank === wRank && d.priority < winner.priority)) {
      winner = d
    }
  }

  return winner.directive
}

// ─── AGENT INVOCATION

async function invokeAgent(
  node: GraphNode, state: RunState,
  precomputed?: { userPrompt: string; systemPrompt: string },
): Promise<AgentResult> {
  const def        = state.registry[node.agent!]
  const command    = state.overrides.provider ?? def.command
  const model      = state.overrides.model ?? def.model
  const userPrompt = precomputed?.userPrompt  ?? renderUserPrompt(sliceContext(state.context, node.slice), node.instruction)
  const sysPrompt  = precomputed?.systemPrompt ?? buildSystemPrompt(state.registry, node)
  const cwd        = resolve(state.context[`_worktree:${node.id}`] ?? node.cwd ?? process.cwd())
  const logFile    = state.storage.logPath(state.runDir, node.id)

  const agentTimeout = node.timeout ?? 600_000  // default 10 minutes

  const invoke = await loadProvider(command)
  const result = await Promise.race([
    invoke({ userPrompt, systemPrompt: sysPrompt, options: Object.keys(node.options ?? {}), cwd, model, logFile }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Agent timeout after ${agentTimeout}ms on node "${node.id}"`)), agentTimeout)),
  ])
  return result
}

// ─── GUARDRAILS

function evalGuardrail(
  g: GuardrailCheck | GuardrailRule,
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): { pass: true } | { pass: false; reason: string } {
  if (typeof g === "function") return g(ctx)
  // GuardrailRule — declarative JS expression
  if (g.nodeId && g.nodeId !== ctx.nodeId) return { pass: true }
  try {
    const { output = "", choice = "", nodeId, context } = ctx
    const esmRequire = createRequire(import.meta.url)
    const pass = new Function("output", "choice", "nodeId", "context", "require",
      `"use strict"; return !!(${g.check})`)(output, choice, nodeId, context, esmRequire)
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

async function errorFallback(state: RunState, nodeId: string, node: GraphNode, error: string): Promise<void> {
  const fallback = resolveFallback(node, state.graph)
  await emitHook("Error", { nodeId, error, fallbackNodeId: fallback }, state)
  return executeNode(fallback, nodeId, state)
}

async function applyDirective(
  d: HookDirective, state: RunState, nodeId: string, node: GraphNode, fromNodeId: string | null,
): Promise<true | void> {
  if (d.action === "abort") throw new Error(`Aborted by hook: ${(d as { reason: string }).reason}`)
  if (d.action === "pause")    { await writePause(state, nodeId, fromNodeId, (d as { reason: string }).reason); return true }
  if (d.action === "redirect") { await executeNode((d as { targetNodeId: string }).targetNodeId, nodeId, state); return true }
  if (d.action === "skip")     { await executeNode(resolveFallback(node, state.graph), nodeId, state); return true }
}

async function writePause(state: RunState, nodeId: string, fromNodeId: string | null, reason?: string): Promise<void> {
  const paused: PausedState = {
    runId: state.runId, nodeId: fromNodeId ?? nodeId, context: state.context,
    agentOutput: state.context[fromNodeId ?? ""] ?? "", reason,
    iterationCounts: Object.fromEntries(state.iterationCounts),
  }
  await state.storage.savePause(state.runDir, paused)
  await saveContext(state)
  const stateFile = join(state.runDir, "state.json")
  await emitHook("Paused", { nodeId, reason, stateFile }, state)
}

// ─── ORCHESTRATOR CORE

async function executeNode(nodeId: string, fromNodeId: string | null, state: RunState): Promise<void> {
  const { graph, context, joinMap, runDir } = state
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) throw new Error(`Node not found: "${nodeId}"`)

  // ── Terminals
  if (node.type === "done")   { await emitHook("RunEnd", { terminal: "done", finalContext: context }, state); return }
  if (node.type === "failed") { await emitHook("RunEnd", { terminal: "failed", finalContext: context }, state); throw new Error("Graph reached failed terminal") }
  if (node.type === "paused") { await writePause(state, nodeId, fromNodeId); return }

  // ── Fork
  if (node.type === "fork") {
    const directive = await emitHook("ForkStart", { nodeId, targets: node.targets! }, state)
    if (directive.action === "abort") throw new Error(`Aborted by hook: ${(directive as { reason: string }).reason}`)
    await Promise.all(node.targets!.map(t => executeNode(t, nodeId, state)))
    await emitHook("ForkJoin", { nodeId, joinedFrom: node.targets! }, state)
    return
  }

  // ── Join
  if (node.type === "join") {
    if (!joinMap.has(nodeId)) joinMap.set(nodeId, new Set())
    const arrived = joinMap.get(nodeId)!
    if (fromNodeId) arrived.add(fromNodeId)
    if (arrived.size < node.waits_for!.length) return
  }

  // ── Subworkflow
  if (node.type === "subworkflow") {
    const raw = context[node.source!]
    if (!raw) return errorFallback(state, nodeId, node, `source "${node.source}" not in context`)

    let inner: Workflow
    try { inner = JSON.parse(raw) }
    catch (err) { return errorFallback(state, nodeId, node, `bad workflow JSON: ${err}`) }

    const importPath = resolve("supertinker.ts").replace(/\.ts$/, "")
    const tsContent = `import type { Workflow } from "${importPath}";\n\nexport const workflow: Workflow = ${JSON.stringify(inner, null, 2)};\n`
    const workflowFile = `${inner.id}.workflow.ts`
    await state.storage.saveFile(runDir, workflowFile, tsContent)
    await emitHook("SubworkflowStart", { nodeId, innerWorkflow: inner }, state)

    const innerRunDir = await state.storage.createRun(`${state.runId}/sub-${inner.id}`)

    const innerContext: Context = {}
    for (const key of node.slice ?? Object.keys(context))
      if (key in context && key !== node.source) innerContext[key] = context[key]

    if (node.cwd) {
      const cwd = resolve(node.cwd)
      inner = { ...inner, graph: { ...inner.graph, nodes: inner.graph.nodes.map(n => (!n.cwd && n.agent) ? { ...n, cwd } : n) } }
    }

    const innerState: RunState = {
      runId: `${state.runId}/${inner.id}`, runDir: innerRunDir,
      context: innerContext, joinMap: new Map(), iterationCounts: new Map(),
      graph: inner.graph, registry: inner.registry,
      guardrails: {
        maxIterations: inner.guardrails?.maxIterations ?? state.guardrails.maxIterations,
        pre:  [...(state.guardrails.pre ?? []),  ...(inner.guardrails?.pre ?? [])],
        post: [...(state.guardrails.post ?? []), ...(inner.guardrails?.post ?? [])],
      },
      overrides: state.overrides,
      hooks: state.hooks,
      storage: state.storage,
    }

    try { await executeNode(inner.graph.start, null, innerState) }
    catch (err) { return errorFallback(state, nodeId, node, String(err)) }

    context[nodeId] = JSON.stringify(innerState.context)
    await saveContext(state)

    await state.storage.saveWorkflow(inner.id, readFileSync(join(runDir, workflowFile), "utf8"))
    await emitHook("SubworkflowEnd", { nodeId, innerContext: innerState.context }, state)

    const next = node.options?.["done"]
    if (next) return executeNode(next, nodeId, state)
    return
  }

  // ── Standard node
  const { guardrails, iterationCounts } = state
  const count = (iterationCounts.get(nodeId) ?? 0) + 1
  iterationCounts.set(nodeId, count)

  if (guardrails.maxIterations && count > guardrails.maxIterations)
    return writePause(state, nodeId, fromNodeId, `node "${nodeId}" exceeded max iterations (${guardrails.maxIterations})`)

  if (guardrails.pre?.length) {
    const pre = runGuardrails(guardrails.pre, { context, nodeId })
    if (!pre.pass) {
      const reason = (pre as { reason: string }).reason
      await emitHook("GuardrailFail", { nodeId, phase: "pre" as const, reason }, state)
      return writePause(state, nodeId, fromNodeId, `pre-guardrail: ${reason}`)
    }
  }

  const sliced     = sliceContext(context, node.slice)
  const userPrompt = renderUserPrompt(sliced, node.instruction)
  const sysPrompt  = buildSystemPrompt(state.registry, node)

  const def = state.registry[node.agent!]
  const command = state.overrides.provider ?? def.command
  const model   = state.overrides.model ?? def.model

  const preDirective = await emitHook("PreAgent", {
    nodeId, agent: node.agent!, provider: command,
    userPrompt, systemPrompt: sysPrompt, slicedContext: sliced,
  }, state)

  if (await applyDirective(preDirective, state, nodeId, node, fromNodeId)) return

  const logFile = state.storage.logPath(state.runDir, node.id)
  const preProviderDirective = await emitHook("PreProvider", {
    nodeId, agent: node.agent!, provider: command,
    userPrompt, systemPrompt: sysPrompt, cwd: resolve(node.cwd ?? process.cwd()), model,
    logFile,
  }, state)
  if (await applyDirective(preProviderDirective, state, nodeId, node, fromNodeId)) return

  let result: AgentResult
  try { result = await invokeAgent(node, state, { userPrompt, systemPrompt: sysPrompt }) }
  catch (err) { return errorFallback(state, nodeId, node, String(err)) }

  const postDirective = await emitHook("PostAgent", {
    nodeId, agent: node.agent!, provider: command, result, transcriptPath: result.transcriptPath,
  }, state)

  if (await applyDirective(postDirective, state, nodeId, node, fromNodeId)) return

  // Post-guardrails — retry once, then pause
  if (guardrails.post?.length) {
    const post = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice })
    if (!post.pass) {
      const postReason = (post as { reason: string }).reason
      await emitHook("GuardrailFail", { nodeId, phase: "post" as const, reason: postReason }, state)
      const retryNode = { ...node, instruction: `${node.instruction ?? ""}\n\nGUARDRAIL FEEDBACK: ${postReason}\nFix the issue and try again.` }
      try { result = await invokeAgent(retryNode, state) }
      catch (err) { return writePause(state, nodeId, fromNodeId, `post-guardrail: ${postReason} (retry failed)`) }
      const post2 = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice })
      if (!post2.pass) {
        const post2Reason = (post2 as { reason: string }).reason
        await emitHook("GuardrailFail", { nodeId, phase: "post" as const, reason: post2Reason }, state)
        return writePause(state, nodeId, fromNodeId, `post-guardrail: ${post2Reason} (after retry)`)
      }
    }
  }

  const nextNodeId = node.options?.[result.choice]
  if (!nextNodeId) return errorFallback(state, nodeId, node, `choice "${result.choice}" not declared`)

  context[nodeId] = result.output
  await saveContext(state)
  return executeNode(nextNodeId, nodeId, state)
}

// ─── WORKFLOW LIBRARY

export async function buildCatalog(storage?: StorageAdapter): Promise<string> {
  const s = storage ?? await loadStorage()
  const entries = await s.listWorkflows()
  if (entries.length === 0) return "No workflows available."
  const lines = entries.map(e => `- ${e.id}: ${e.description} [${e.source}: ${e.file}]`)
  return `Available workflows (${entries.length}):\n${lines.join("\n")}`
}

// ─── PUBLIC API

export async function run({ workflow, initialContext = {}, overrides = {} }: { workflow: Workflow; initialContext?: Context; overrides?: ProviderOverrides }): Promise<void> {
  const { graph, registry } = workflow
  const storage = await loadStorage()
  const runId  = `${workflow.id}-${Date.now()}`
  const runDir = await storage.createRun(runId)

  const hooks = await loadHooks(runDir)

  const state: RunState = {
    runId, runDir, context: { ...initialContext }, joinMap: new Map(),
    iterationCounts: new Map(), graph, registry, guardrails: workflow.guardrails ?? {}, hooks, storage, overrides,
  }

  const startDirective = await emitHook("RunStart", { workflow, initialContext }, state)
  if (startDirective.action === "abort") {
    throw new Error(`Aborted by hook: ${(startDirective as { action: "abort"; reason: string }).reason}`)
  }

  await executeNode(graph.start, null, state)
}

export async function resume({ workflow, runId, choice, overrides = {} }: { workflow: Workflow; runId: string; choice: string; overrides?: ProviderOverrides }): Promise<void> {
  const { graph, registry } = workflow
  const storage = await loadStorage()
  const runDir = join("/tmp/orchestrator", runId)
  if (!await storage.pauseExists(runDir)) throw new Error(`No paused state for run: ${runId}`)

  const paused = await storage.loadPause(runDir)
  const hooks = await loadHooks(runDir)
  const fromNode = graph.nodes.find(n => n.id === paused.nodeId)
  if (!fromNode?.options?.[choice]) throw new Error(`Choice "${choice}" not valid for "${paused.nodeId}". Options: ${Object.keys(fromNode?.options ?? {})}`)

  const restoredIterations = new Map(Object.entries(paused.iterationCounts ?? {}))
  const state: RunState = {
    runId, runDir, context: paused.context, joinMap: new Map(),
    iterationCounts: restoredIterations, graph, registry, guardrails: workflow.guardrails ?? {}, hooks, storage, overrides,
  }

  const resumeDirective = await emitHook("Resumed", { nodeId: paused.nodeId, choice }, state)
  if (resumeDirective.action === "abort") {
    throw new Error(`Aborted by hook: ${(resumeDirective as { action: "abort"; reason: string }).reason}`)
  }

  await executeNode(fromNode.options[choice], paused.nodeId, state)
}

// ─── CLI

async function cli(): Promise<void> {
  const argv = process.argv.slice(2)
  const cmd  = argv[0]
  const get  = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

  if (cmd === "run") {
    const workflowRef  = get("--workflow") ?? "meta"
    const prompt       = get("--prompt")
    const provider     = get("--provider")
    const model        = get("--model")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    const storage = await loadStorage()
    const workflowPath = await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    const initialContext: Context = { catalog: await buildCatalog(storage), cwd: process.cwd() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext, overrides })
    return
  }

  if (cmd === "resume") {
    const runId = get("--run"), choice = get("--choice"), workflowRef = get("--workflow")
    const provider = get("--provider"), model = get("--model")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    if (!runId || !choice || !workflowRef) { console.error("Usage: supertinker resume --run <id> --choice <label> --workflow <name|path>"); process.exit(1) }
    const storage = await loadStorage()
    const { workflow } = await import(await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef))
    await resume({ workflow, runId, choice, overrides })
    return
  }

  if (cmd === "status") {
    const runId = get("--run")
    if (!runId) { console.error("Usage: supertinker status --run <runId>"); process.exit(1) }
    const runDir = join("/tmp/orchestrator", runId)
    if (!existsSync(runDir)) { console.error(`Run directory not found: ${runDir}`); process.exit(1) }

    const ctxPath = join(runDir, "context.json")
    const statePath = join(runDir, "state.json")
    const hasPause = existsSync(statePath)
    const hasContext = existsSync(ctxPath)

    console.log(`\n  Run: ${runId}`)
    console.log(`  Dir: ${runDir}`)
    console.log(`  Status: ${hasPause ? "PAUSED" : "completed"}\n`)

    if (hasPause) {
      const paused: PausedState = JSON.parse(readFileSync(statePath, "utf8"))
      console.log(`  Paused at: ${paused.nodeId}`)
      if (paused.reason) console.log(`  Reason:    ${paused.reason}`)
      if (paused.iterationCounts) {
        const counts = Object.entries(paused.iterationCounts).filter(([, v]) => v > 0)
        if (counts.length > 0) console.log(`  Iterations: ${counts.map(([k, v]) => `${k}=${v}`).join(", ")}`)
      }
      console.log()
    }

    if (hasContext) {
      const ctx = JSON.parse(readFileSync(ctxPath, "utf8"))
      const keys = Object.keys(ctx)
      console.log(`  Context keys (${keys.length}):`)
      for (const key of keys) {
        const val = ctx[key]
        const preview = val.length > 120 ? val.slice(0, 120) + "..." : val
        console.log(`    [${key}] (${val.length} chars) ${preview.replace(/\n/g, " ")}`)
      }
      console.log()
    }

    const logPath = join(runDir, "orchestrator.log")
    if (existsSync(logPath)) {
      const lines = readFileSync(logPath, "utf8").trim().split("\n")
      const tail = lines.slice(-10)
      console.log(`  Log (last ${tail.length} of ${lines.length} lines):`)
      for (const line of tail) console.log(`    ${line}`)
      console.log()
    }
    return
  }

  if (cmd === "list") {
    const flag = argv[1]
    if (flag === "--hooks") {
      const tmpDir = join("/tmp/orchestrator", "hook-list")
      mkdirSync(tmpDir, { recursive: true })
      const hooks = await loadHooks(tmpDir)
      const entries: string[] = []
      const seen = new Set<string>()
      for (const [, hookList] of hooks) {
        for (const h of hookList) {
          if (seen.has(h.name)) continue
          seen.add(h.name)
          entries.push(`- ${h.name}: ${h.description ?? "(no description)"}  events: [${h.events.join(", ")}]  parallel: ${h.parallel}  priority: ${h.priority}`)
        }
      }
      console.log(entries.length === 0 ? "No hooks found." : `Hooks (${entries.length}):\n${entries.join("\n")}`)
      return
    }
    console.log(await buildCatalog())
    return
  }

  console.log(`supertinker — minimal agent orchestrator

Commands:
  run     [--workflow <name|path>] --prompt <text>   (default: meta)
  resume  --run <runId> --choice <label> --workflow <name|path>
  status  --run <runId>   inspect a run's state and context
  list           show available workflows
  list --hooks   show discovered hooks

Examples:
  tsx supertinker.ts run --prompt "Build a REST API"
  tsx supertinker.ts run --workflow meta --prompt "Build a REST API"
  tsx supertinker.ts status --run meta-1234567890
  tsx supertinker.ts list`)
}

// ─── TMUXAUTO-LAUNCH ────────────────────────────────────────────────────────

function ensureTmux(): boolean {
  if (!!process.env.TMUX) return true
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

// ─── ENTRYPOINT

const isMain = process.argv[1]?.endsWith("supertinker.ts") || process.argv[1]?.endsWith("supertinker.js")

if (isMain) {
  const cmd = process.argv[2]
  if (!cmd || cmd === "list" || cmd === "status" || cmd === "help") cli().catch(err => { console.error(err); process.exit(1) })
  else if (ensureTmux()) cli().catch(err => { console.error(err); process.exit(1) })
}