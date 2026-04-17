/**
 * supertinker.ts — A minimal agent orchestrator (library)
 *
 * Public API: run(), resume(), buildCatalog(), loadStorage(), loadHooks()
 * CLI entrypoint: see cli.ts
 */

import { appendFileSync, existsSync, mkdirSync, readdirSync,
         readFileSync, writeFileSync }                          from "fs"
import { join, resolve }                                        from "path"
import { homedir }                                              from "os"
import { createRequire }                                        from "module"

// ─── TYPES

export interface GraphNode {
  id:           string
  // Built-ins: "fork" | "join" | "done" | "failed" | "paused" | "subworkflow"
  // Or any custom type registered via plugins/nodes/<name>.ts
  type?:        string
  agent?:       string
  cwd?:         string
  slice?:       string[]
  instruction?: string
  systemPrompt?: string
  options?:     Record<string, string>
  timeout?:     number
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
  createRun(runId: string): Promise<string>
  saveContext(runDir: string, context: Context): Promise<void>
  loadContext(runDir: string): Promise<Context>
  savePause(runDir: string, state: PausedState): Promise<void>
  loadPause(runDir: string): Promise<PausedState>
  pauseExists(runDir: string): Promise<boolean>
  appendLog(runDir: string, line: string): Promise<void>
  saveFile(runDir: string, name: string, content: string): Promise<void>
  saveWorkflow(id: string, content: string): Promise<void>
  logPath(runDir: string, nodeId: string): string
  resolveWorkflow(name: string): Promise<string | null>
  listWorkflows(): Promise<Array<{ id: string; description: string; file: string; source: string }>>
}

const BUILTIN_DIR = resolve(join(new URL(import.meta.url).pathname, ".."))
const USER_DIR    = join(homedir(), ".supertinker")
const PROJECT_DIR = join(process.cwd(), ".supertinker")
const SEARCH_DIRS = [PROJECT_DIR, USER_DIR, BUILTIN_DIR]  // project-local wins
const RUN_ROOT    = "/tmp/orchestrator"

export const filesystemStorage: StorageAdapter = {
  async createRun(runId) {
    const dir = join(RUN_ROOT, runId)
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
    for (const { path, file, source } of walkPluginFiles("workflows", [".workflow.ts"])) {
      try {
        const raw = readFileSync(path, "utf8")
        const id   = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)?.[1] ?? file
        const description = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)?.[1] ?? "(no description)"
        entries.push({ id, description, file, source })
      } catch {}
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
  nodeTypes: NodeTypeRegistry
}

// ─── PLUGIN WALKER

function* walkPluginFiles(
  subdir: string, exts: string[],
): Generator<{ path: string; file: string; source: string }> {
  const sources: Array<[string, string]> = [
    [PROJECT_DIR, "project"],
    [USER_DIR,    "user"],
    [BUILTIN_DIR, "built-in"],
  ]
  for (const [base, source] of sources) {
    const dir = join(base, subdir)
    if (!existsSync(dir)) continue
    let files: string[]
    try { files = readdirSync(dir) } catch { continue }
    for (const file of files) {
      if (!exts.some(e => file.endsWith(e))) continue
      yield { path: join(dir, file), file, source }
    }
  }
}

// ─── HOOKS

// Built-in lifecycle event names. Custom node-type plugins may emit any
// additional string event name via ctx.emitHook; hook plugins subscribe by
// listing the same string in their `events` array.
export const BUILTIN_HOOK_EVENTS = [
  "RunStart", "RunEnd", "NodeStart", "NodeEnd",
  "PreAgent", "PostAgent", "PreProvider", "Paused", "Resumed",
  "ForkStart", "ForkJoin", "GuardrailFail", "SubworkflowStart", "SubworkflowEnd", "Error",
] as const

export type BuiltinHookEvent = typeof BUILTIN_HOOK_EVENTS[number]
export type HookEventName    = BuiltinHookEvent | string

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
  NodeStart:        { nodeId: string; nodeType: string; from: string | null }
  NodeEnd:          { nodeId: string; nodeType: string; to: string | null }
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

export type HookEvent =
  | { [K in BuiltinHookEvent]: HookEventBase & { event: K } & HookEventMap[K] }[BuiltinHookEvent]
  | (HookEventBase & { event: string } & Record<string, unknown>)

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
  parallel?:    boolean
  priority?:    number
  timeout?:     number
  handler:      (event: HookEvent) => Promise<HookDirective>
}

export type HookIndex = Map<HookEventName, Hook[]>

// ─── NODE TYPE PLUGINS

// Built-in node types are dispatched directly inside executeNode. Custom
// types are loaded from <SEARCH_DIR>/nodes/<name>.{ts,js} and rejected at
// load time if they collide with a built-in.
export const BUILTIN_NODE_TYPES = new Set<string>([
  "fork", "join", "done", "failed", "paused", "subworkflow",
])

export interface NodeExecuteCtx {
  node:        GraphNode
  fromNodeId:  string | null
  context:     Context                       // mutable; === state.context
  runId:       string
  runDir:      string
  storage:     StorageAdapter

  // Helpers — the stable surface custom nodes should rely on:
  slice:           (keys?: string[]) => Context
  render:          (instruction?: string, keys?: string[]) => string
  saveContext:     () => Promise<void>
  executeNode:     (nodeId: string, fromNodeId: string | null) => Promise<void>
  invokeAgent:     (node: GraphNode, pre?: { userPrompt: string; systemPrompt: string }) => Promise<AgentResult>
  // Wraps invokeAgent with PreAgent → PreProvider → invokeAgent → PostAgent
  // emission and directive handling — same semantics as the standard-agent
  // path. Returns { redirected: true } when a hook redirected/skipped/paused
  // the flow and the caller should stop driving execution itself.
  runAgent:        (node: GraphNode) => Promise<AgentResult | { redirected: true }>
  emitHook:        (event: HookEventName, payload: Record<string, unknown>) => Promise<HookDirective>
  writePause:      (reason?: string) => Promise<void>
  errorFallback:   (error: string) => Promise<void>
  resolveFallback: () => string
  log:             (line: string) => Promise<void>
}

export interface NodeTypeDefinition {
  type:         string
  description?: string
  schema?: {
    requires?: string[]
    optional?: string[]
    example?:  Partial<GraphNode>
  }
  validate?: (node: GraphNode, graph: Graph) => string | null
  execute:   (ctx: NodeExecuteCtx) => Promise<void>
}

export type NodeTypeRegistry = Map<string, NodeTypeDefinition>

// ─── CONTEXT + SYSTEM PROMPT

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

async function saveContext(state: RunState): Promise<void> {
  await state.storage.saveContext(state.runDir, state.context)
}

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

// ─── NODE TYPE LOADER

async function readNodeTypePlugins(): Promise<Array<{ def: NodeTypeDefinition; source: string; file: string }>> {
  const out: Array<{ def: NodeTypeDefinition; source: string; file: string }> = []
  for (const { path, file, source } of walkPluginFiles("nodes", [".ts", ".js"])) {
    try {
      const mod = await import(path)
      const def = (mod.node ?? mod.default?.node) as NodeTypeDefinition | undefined
      if (!def || typeof def.execute !== "function" || !def.type) continue
      out.push({ def, source, file })
    } catch {}
  }
  return out
}

export async function loadNodeTypes(runDir: string): Promise<NodeTypeRegistry> {
  const registry: NodeTypeRegistry = new Map()
  const loaded: string[] = []
  for (const { def, file } of await readNodeTypePlugins()) {
    if (BUILTIN_NODE_TYPES.has(def.type)) {
      bootstrapLog(runDir, "node-types", `WARN: skipping ${file} — node type "${def.type}" shadows a built-in`)
      continue
    }
    if (registry.has(def.type)) continue  // first match (project > user > built-in) wins
    registry.set(def.type, def)
    loaded.push(def.type)
  }
  bootstrapLog(runDir, "node-types", loaded.length > 0 ? `loaded: ${loaded.join(", ")}` : "no custom node types found")
  return registry
}

export async function buildNodeCatalog(): Promise<string> {
  const seen = new Set<string>()
  const entries: NodeTypeDefinition[] = []
  for (const { def } of await readNodeTypePlugins()) {
    if (BUILTIN_NODE_TYPES.has(def.type) || seen.has(def.type)) continue
    seen.add(def.type)
    entries.push(def)
  }
  if (entries.length === 0) return "No custom node types."
  const lines = entries.map(e => {
    const example = e.schema?.example ? `\n  example: ${JSON.stringify(e.schema.example)}` : ""
    const requires = e.schema?.requires?.length ? `\n  requires: ${e.schema.requires.join(", ")}` : ""
    return `- ${e.type}: ${e.description ?? "(no description)"}${requires}${example}`
  })
  return `Custom node types (${entries.length}):\n${lines.join("\n")}`
}

// ─── HOOK SYSTEM

const VALID_EVENTS = new Set<HookEventName>(BUILTIN_HOOK_EVENTS)

const DIRECTIVE_RANK: Record<string, number> = {
  abort: 5, pause: 4, redirect: 3, skip: 2, continue: 1,
}

// Directive support is enforced for built-in events only. Custom event names
// (defined by node-type plugins) accept all directives — the plugin author
// owns the contract for what each directive means in their event.
const DIRECTIVE_SUPPORT: Record<string, Set<HookEventName>> = {
  abort:    new Set(VALID_EVENTS),
  pause:    new Set(["PreAgent", "PreProvider", "PostAgent", "GuardrailFail", "SubworkflowStart", "NodeStart"]),
  redirect: new Set(["PreAgent", "PreProvider", "PostAgent"]),
  skip:     new Set(["PreAgent", "PreProvider"]),
  continue: new Set(VALID_EVENTS),
}

function bootstrapLog(runDir: string, label: string, msg: string): void {
  const line = `[${new Date().toISOString().slice(11, 19)}] BOOT    ${label.padEnd(22)} ${msg}`
  appendFileSync(join(runDir, "orchestrator.log"), line + "\n")
  process.stdout.write(line + "\n")
}

export async function loadHooks(runDir: string): Promise<HookIndex> {
  const index: HookIndex = new Map()
  for (const name of VALID_EVENTS) index.set(name, [])

  const loaded: string[] = []
  for (const { path, file } of walkPluginFiles("hooks", [".ts", ".js"])) {
    try {
      const mod = await import(path)
      const h = mod.hook ?? mod.default?.hook
      // Accept any non-empty string event name. Built-in events come pre-keyed
      // in the index; custom events (from node-type plugins) are added on demand.
      const events: HookEventName[] = Array.isArray(h?.events)
        ? (h.events as unknown[]).filter((e): e is string => typeof e === "string" && e.length > 0)
        : []
      if (!h || typeof h.handler !== "function" || !h.name || events.length === 0) {
        bootstrapLog(runDir, "hooks", `WARN: skipping ${file} — invalid hook export`)
        continue
      }
      const hook: Hook = {
        name:        h.name,
        description: h.description,
        events,
        parallel:    h.parallel ?? true,
        priority:    h.priority ?? 50,
        timeout:     h.timeout  ?? 30000,
        handler:     h.handler,
      }
      for (const evt of hook.events) {
        if (!index.has(evt)) index.set(evt, [])
        index.get(evt)!.push(hook)
      }
      loaded.push(`${hook.name} (${hook.events.join(", ")})`)
    } catch (err) {
      bootstrapLog(runDir, "hooks", `WARN: failed to load ${file}: ${err}`)
    }
  }

  for (const hooks of index.values()) hooks.sort((a, b) => a.priority! - b.priority!)

  bootstrapLog(runDir, "hooks", loaded.length > 0 ? `loaded: ${loaded.join(", ")}` : "no hooks found")
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

  const isBuiltinEvent = VALID_EVENTS.has(event)
  const directives: Array<{ directive: HookDirective; priority: number }> = []

  const runOne = async (hook: Hook): Promise<void> => {
    try {
      const result = await Promise.race([
        hook.handler(eventObj),
        new Promise<HookDirective>((_, rej) => setTimeout(() => rej(new Error("timeout")), hook.timeout ?? 30000)),
      ])

      let directive: HookDirective = result
      if (result.action !== "continue") {
        // Custom (non-built-in) events accept all directives — the plugin
        // author owns the contract for what each directive means.
        const supported = DIRECTIVE_SUPPORT[result.action]
        if (isBuiltinEvent && !supported?.has(event)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: "${result.action}" not supported for ${event}, treating as continue\n`)
          directive = { action: "continue" }
        } else if (result.action === "redirect" &&
                   !state.graph.nodes.some(n => n.id === result.targetNodeId)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: redirect target "${result.targetNodeId}" not found, treating as continue\n`)
          directive = { action: "continue" }
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

  for (const hook of hooks) if (hook.parallel === false) await runOne(hook)
  const parallel = hooks.filter(h => h.parallel !== false)
  if (parallel.length > 0) await Promise.all(parallel.map(runOne))

  let winner: { directive: HookDirective; priority: number } = { directive: { action: "continue" }, priority: 100 }
  for (const d of directives) {
    const dRank = DIRECTIVE_RANK[d.directive.action] ?? 1
    const wRank = DIRECTIVE_RANK[winner.directive.action] ?? 1
    if (dRank > wRank || (dRank === wRank && d.priority < winner.priority)) winner = d
  }
  return winner.directive
}

function abortIfHook(d: HookDirective): void {
  if (d.action === "abort") throw new Error(`Aborted by hook: ${d.reason}`)
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
  return Promise.race([
    invoke({ userPrompt, systemPrompt: sysPrompt, options: Object.keys(node.options ?? {}), cwd, model, logFile }),
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`Agent timeout after ${agentTimeout}ms on node "${node.id}"`)), agentTimeout)),
  ])
}

// Runs the PreAgent → PreProvider → invokeAgent → PostAgent pipeline with
// directive handling. Shared by the standard-node path and the runAgent helper
// exposed to custom node-type plugins.
async function runAgentPipeline(
  node: GraphNode, state: RunState, fromNodeId: string | null,
): Promise<AgentResult | { redirected: true }> {
  if (!node.agent) throw new Error(`runAgent called without agent on node "${node.id}"`)
  const sliced     = sliceContext(state.context, node.slice)
  const userPrompt = renderUserPrompt(sliced, node.instruction)
  const sysPrompt  = buildSystemPrompt(state.registry, node)
  const def        = state.registry[node.agent]
  const command    = state.overrides.provider ?? def.command
  const model      = state.overrides.model ?? def.model

  const pre = await emitHook("PreAgent", {
    nodeId: node.id, agent: node.agent, provider: command,
    userPrompt, systemPrompt: sysPrompt, slicedContext: sliced,
  }, state)
  if (await applyDirective(pre, state, node, fromNodeId)) return { redirected: true }

  const logFile = state.storage.logPath(state.runDir, node.id)
  const preProv = await emitHook("PreProvider", {
    nodeId: node.id, agent: node.agent, provider: command,
    userPrompt, systemPrompt: sysPrompt, cwd: resolve(node.cwd ?? process.cwd()), model, logFile,
  }, state)
  if (await applyDirective(preProv, state, node, fromNodeId)) return { redirected: true }

  const result = await invokeAgent(node, state, { userPrompt, systemPrompt: sysPrompt })
  const post = await emitHook("PostAgent", {
    nodeId: node.id, agent: node.agent, provider: command, result, transcriptPath: result.transcriptPath,
  }, state)
  if (await applyDirective(post, state, node, fromNodeId)) return { redirected: true }
  return result
}

// ─── GUARDRAILS

function evalGuardrail(
  g: GuardrailCheck | GuardrailRule,
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): { pass: true } | { pass: false; reason: string } {
  if (typeof g === "function") return g(ctx)
  if (g.nodeId && g.nodeId !== ctx.nodeId) return { pass: true }
  try {
    const { output = "", choice = "", nodeId, context } = ctx
    const esmRequire = createRequire(import.meta.url)
    const pass = new Function("output", "choice", "nodeId", "context", "require",
      `"use strict"; return !!(${g.check})`)(output, choice, nodeId, context, esmRequire)
    return pass ? { pass: true } : { pass: false, reason: g.reason }
  } catch (err) { return { pass: false, reason: `guardrail eval error: ${err}` } }
}

// Returns null on pass, or the failure reason string.
function runGuardrails(
  checks: (GuardrailCheck | GuardrailRule)[],
  ctx: { context: Context; nodeId: string; output?: string; choice?: string },
): string | null {
  for (const g of checks) {
    const result = evalGuardrail(g, ctx)
    if (!result.pass) return (result as { reason: string }).reason
  }
  return null
}

async function errorFallback(state: RunState, nodeId: string, node: GraphNode, error: string): Promise<void> {
  const fallback = resolveFallback(node, state.graph)
  await emitHook("Error", { nodeId, error, fallbackNodeId: fallback }, state)
  return executeNode(fallback, nodeId, state)
}

async function applyDirective(
  d: HookDirective, state: RunState, node: GraphNode, fromNodeId: string | null,
): Promise<boolean> {
  if (d.action === "continue") return false
  if (d.action === "abort")    throw new Error(`Aborted by hook: ${d.reason}`)
  if (d.action === "pause")    await writePause(state, node.id, fromNodeId, d.reason)
  if (d.action === "redirect") await executeNode(d.targetNodeId, node.id, state)
  if (d.action === "skip")     await executeNode(resolveFallback(node, state.graph), node.id, state)
  return true
}

async function writePause(state: RunState, nodeId: string, fromNodeId: string | null, reason?: string): Promise<void> {
  const paused: PausedState = {
    runId: state.runId, nodeId: fromNodeId ?? nodeId, context: state.context,
    agentOutput: state.context[fromNodeId ?? ""] ?? "", reason,
    iterationCounts: Object.fromEntries(state.iterationCounts),
  }
  await state.storage.savePause(state.runDir, paused)
  await saveContext(state)
  await emitHook("Paused", { nodeId, reason, stateFile: join(state.runDir, "state.json") }, state)
}

// ─── ORCHESTRATOR CORE

async function executeNode(nodeId: string, fromNodeId: string | null, state: RunState): Promise<void> {
  const { graph, context, joinMap, runDir } = state
  const node = graph.nodes.find(n => n.id === nodeId)
  if (!node) throw new Error(`Node not found: "${nodeId}"`)

  // NodeStart fires once per node arrival, before any type-specific event
  // (PreAgent, ForkStart, SubworkflowStart, …).
  const nodeType = node.type ?? "standard"
  const nodeEnd  = (to: string | null) => emitHook("NodeEnd", { nodeId, nodeType, to }, state)

  const startDirective = await emitHook("NodeStart", { nodeId, nodeType, from: fromNodeId }, state)
  abortIfHook(startDirective)
  if (startDirective.action === "pause") {
    await writePause(state, nodeId, fromNodeId, startDirective.reason)
    return
  }

  // ── Terminals
  if (node.type === "done" || node.type === "failed" || node.type === "paused") {
    await nodeEnd(null)
    if (node.type === "paused") return writePause(state, nodeId, fromNodeId)
    await emitHook("RunEnd", { terminal: node.type, finalContext: context }, state)
    if (node.type === "failed") throw new Error("Graph reached failed terminal")
    return
  }

  // ── Fork
  if (node.type === "fork") {
    abortIfHook(await emitHook("ForkStart", { nodeId, targets: node.targets! }, state))
    await Promise.all(node.targets!.map(t => executeNode(t, nodeId, state)))
    await emitHook("ForkJoin", { nodeId, joinedFrom: node.targets! }, state)
    await nodeEnd(null)
    return
  }

  // ── Join (wait for all inbound edges before proceeding as a standard node)
  if (node.type === "join") {
    if (!joinMap.has(nodeId)) joinMap.set(nodeId, new Set())
    const arrived = joinMap.get(nodeId)!
    if (fromNodeId) arrived.add(fromNodeId)
    if (arrived.size < node.waits_for!.length) {
      await nodeEnd(null)
      return
    }
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
      ...state,
      runId: `${state.runId}/${inner.id}`, runDir: innerRunDir,
      context: innerContext, joinMap: new Map(), iterationCounts: new Map(),
      graph: inner.graph, registry: inner.registry,
      guardrails: {
        maxIterations: inner.guardrails?.maxIterations ?? state.guardrails.maxIterations,
        pre:  [...(state.guardrails.pre  ?? []), ...(inner.guardrails?.pre  ?? [])],
        post: [...(state.guardrails.post ?? []), ...(inner.guardrails?.post ?? [])],
      },
    }

    try { await executeNode(inner.graph.start, null, innerState) }
    catch (err) { return errorFallback(state, nodeId, node, String(err)) }

    context[nodeId] = JSON.stringify(innerState.context)
    await saveContext(state)

    await state.storage.saveWorkflow(inner.id, readFileSync(join(runDir, workflowFile), "utf8"))
    await emitHook("SubworkflowEnd", { nodeId, innerContext: innerState.context }, state)

    const next = node.options?.["done"]
    await nodeEnd(next ?? null)
    if (next) return executeNode(next, nodeId, state)
    return
  }

  // ── Custom node types (plugins)
  if (node.type && !BUILTIN_NODE_TYPES.has(node.type)) {
    const def = state.nodeTypes.get(node.type)
    if (!def) return errorFallback(state, nodeId, node,
      `unknown node.type "${node.type}" — no built-in handler and no plugin in <search>/nodes/`)
    if (def.validate) {
      const err = def.validate(node, state.graph)
      if (err) return errorFallback(state, nodeId, node, `node-type validation: ${err}`)
    }
    try { await def.execute(buildNodeExecuteCtx(node, fromNodeId, state)) }
    catch (err) { return errorFallback(state, nodeId, node, String(err)) }
    await nodeEnd(null)
    return
  }

  // ── Standard node
  const { guardrails, iterationCounts } = state
  const count = (iterationCounts.get(nodeId) ?? 0) + 1
  iterationCounts.set(nodeId, count)

  if (guardrails.maxIterations && count > guardrails.maxIterations)
    return writePause(state, nodeId, fromNodeId, `node "${nodeId}" exceeded max iterations (${guardrails.maxIterations})`)

  if (guardrails.pre?.length) {
    const preReason = runGuardrails(guardrails.pre, { context, nodeId })
    if (preReason) {
      await emitHook("GuardrailFail", { nodeId, phase: "pre" as const, reason: preReason }, state)
      return writePause(state, nodeId, fromNodeId, `pre-guardrail: ${preReason}`)
    }
  }

  const piped = await runAgentPipeline(node, state, fromNodeId)
  if ("redirected" in piped) { await nodeEnd(null); return }
  let result: AgentResult = piped

  // Post-guardrails — retry once, then pause
  if (guardrails.post?.length) {
    const check = () => runGuardrails(guardrails.post!, { context, nodeId, output: result.output, choice: result.choice })
    let reason = check()
    if (reason) {
      await emitHook("GuardrailFail", { nodeId, phase: "post" as const, reason }, state)
      const retryNode = { ...node, instruction: `${node.instruction ?? ""}\n\nGUARDRAIL FEEDBACK: ${reason}\nFix the issue and try again.` }
      try { result = await invokeAgent(retryNode, state) }
      catch { return writePause(state, nodeId, fromNodeId, `post-guardrail: ${reason} (retry failed)`) }
      reason = check()
      if (reason) {
        await emitHook("GuardrailFail", { nodeId, phase: "post" as const, reason }, state)
        return writePause(state, nodeId, fromNodeId, `post-guardrail: ${reason} (after retry)`)
      }
    }
  }

  const nextNodeId = node.options?.[result.choice]
  if (!nextNodeId) return errorFallback(state, nodeId, node, `choice "${result.choice}" not declared`)

  context[nodeId] = result.output
  await saveContext(state)
  await nodeEnd(nextNodeId)
  return executeNode(nextNodeId, nodeId, state)
}

function buildNodeExecuteCtx(node: GraphNode, fromNodeId: string | null, state: RunState): NodeExecuteCtx {
  return {
    node,
    fromNodeId,
    context: state.context,
    runId:   state.runId,
    runDir:  state.runDir,
    storage: state.storage,
    slice:           (keys) => sliceContext(state.context, keys),
    render:          (instruction, keys) => renderUserPrompt(sliceContext(state.context, keys), instruction),
    saveContext:     () => saveContext(state),
    executeNode:     (id, from) => executeNode(id, from, state),
    invokeAgent:     (n, pre) => invokeAgent(n, state, pre),
    runAgent:        (n) => runAgentPipeline(n, state, fromNodeId),
    emitHook:        (event, payload) => emitHook(event, payload, state),
    writePause:      (reason) => writePause(state, node.id, fromNodeId, reason),
    errorFallback:   (error) => errorFallback(state, node.id, node, error),
    resolveFallback: () => resolveFallback(node, state.graph),
    log:             (line) => state.storage.appendLog(state.runDir, line),
  }
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

async function buildRunState(
  runId: string, runDir: string, workflow: Workflow, context: Context,
  iterationCounts: Map<string, number>, overrides: ProviderOverrides, storage: StorageAdapter,
): Promise<RunState> {
  const [hooks, nodeTypes] = await Promise.all([loadHooks(runDir), loadNodeTypes(runDir)])
  return {
    runId, runDir, context, joinMap: new Map(), iterationCounts,
    graph: workflow.graph, registry: workflow.registry,
    guardrails: workflow.guardrails ?? {},
    hooks, nodeTypes, storage, overrides,
  }
}

export async function run({ workflow, initialContext = {}, overrides = {} }: { workflow: Workflow; initialContext?: Context; overrides?: ProviderOverrides }): Promise<void> {
  const storage = await loadStorage()
  const runId   = `${workflow.id}-${Date.now()}`
  const runDir  = await storage.createRun(runId)
  const state   = await buildRunState(runId, runDir, workflow, { ...initialContext }, new Map(), overrides, storage)
  abortIfHook(await emitHook("RunStart", { workflow, initialContext }, state))
  await executeNode(workflow.graph.start, null, state)
}

export async function resume({ workflow, runId, choice, overrides = {} }: { workflow: Workflow; runId: string; choice: string; overrides?: ProviderOverrides }): Promise<void> {
  const storage = await loadStorage()
  const runDir  = join(RUN_ROOT, runId)
  if (!await storage.pauseExists(runDir)) throw new Error(`No paused state for run: ${runId}`)

  const paused   = await storage.loadPause(runDir)
  const fromNode = workflow.graph.nodes.find(n => n.id === paused.nodeId)
  if (!fromNode?.options?.[choice]) throw new Error(`Choice "${choice}" not valid for "${paused.nodeId}". Options: ${Object.keys(fromNode?.options ?? {})}`)

  const iterationCounts = new Map(Object.entries(paused.iterationCounts ?? {}))
  const state = await buildRunState(runId, runDir, workflow, paused.context, iterationCounts, overrides, storage)
  abortIfHook(await emitHook("Resumed", { nodeId: paused.nodeId, choice }, state))
  await executeNode(fromNode.options[choice], paused.nodeId, state)
}
