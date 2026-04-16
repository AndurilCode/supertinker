#!/usr/bin/env bun
// @bun
import { createRequire } from "node:module";
var __create = Object.create;
var __getProtoOf = Object.getPrototypeOf;
var __defProp = Object.defineProperty;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __toESM = (mod, isNodeMode, target) => {
  target = mod != null ? __create(__getProtoOf(mod)) : {};
  const to = isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target;
  for (let key of __getOwnPropNames(mod))
    if (!__hasOwnProp.call(to, key))
      __defProp(to, key, {
        get: () => mod[key],
        enumerable: true
      });
  return to;
};
var __require = /* @__PURE__ */ createRequire(import.meta.url);

// ../../../../private/tmp/supertinker-entry-XXXX.ts
import { existsSync as existsSync2, mkdirSync as mkdirSync2, writeFileSync as writeFileSync2, readFileSync as readFileSync2 } from "fs";
import { join as join2, resolve as resolve2 } from "path";
import { homedir as homedir2 } from "os";

// supertinker.ts
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createRequire as createRequire2 } from "module";
var BUILTIN_DIR = resolve(join(new URL(import.meta.url).pathname, ".."));
var USER_DIR = join(homedir(), ".supertinker");
var PROJECT_DIR = join(process.cwd(), ".supertinker");
var SEARCH_DIRS = [PROJECT_DIR, USER_DIR, BUILTIN_DIR];
var filesystemStorage = {
  async createRun(runId) {
    const dir = join("/tmp/orchestrator", runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  async saveContext(runDir, context) {
    writeFileSync(join(runDir, "context.json"), JSON.stringify(context, null, 2));
  },
  async loadContext(runDir) {
    return JSON.parse(readFileSync(join(runDir, "context.json"), "utf8"));
  },
  async savePause(runDir, state) {
    writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2));
  },
  async loadPause(runDir) {
    return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"));
  },
  async pauseExists(runDir) {
    return existsSync(join(runDir, "state.json"));
  },
  async appendLog(runDir, line) {
    appendFileSync(join(runDir, "orchestrator.log"), line + `
`);
  },
  logPath(runDir, nodeId) {
    return join(runDir, `${nodeId}.log`);
  },
  async saveFile(runDir, name, content) {
    writeFileSync(join(runDir, name), content);
  },
  async saveWorkflow(id, content) {
    const dir = join(USER_DIR, "workflows");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${id}.workflow.ts`), content);
  },
  async resolveWorkflow(name) {
    const file = name.endsWith(".workflow.ts") ? name : `${name}.workflow.ts`;
    for (const base of SEARCH_DIRS) {
      const p = join(base, "workflows", file);
      if (existsSync(p))
        return p;
    }
    return null;
  },
  async listWorkflows() {
    const entries = [];
    const sources = [
      [join(PROJECT_DIR, "workflows"), "project"],
      [join(USER_DIR, "workflows"), "library"],
      [join(BUILTIN_DIR, "workflows"), "built-in"]
    ];
    for (const [dir, source] of sources) {
      let files;
      try {
        files = readdirSync(dir).filter((f) => f.endsWith(".workflow.ts"));
      } catch {
        continue;
      }
      for (const file of files) {
        try {
          const raw = readFileSync(join(dir, file), "utf8");
          const id = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)?.[1] ?? file;
          const description = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)?.[1] ?? "(no description)";
          entries.push({ id, description, file, source });
        } catch {}
      }
    }
    return entries;
  }
};
function sliceContext(ctx, keys) {
  if (!keys)
    return ctx;
  return Object.fromEntries(keys.filter((k) => (k in ctx)).map((k) => [k, ctx[k]]));
}
function renderUserPrompt(ctx, instruction) {
  const sections = Object.entries(ctx).map(([k, v]) => `[${k}]
${v}`).join(`

`);
  return instruction ? `${instruction}

${sections}` : sections;
}
function resolveFallback(node, graph) {
  return node.fallback ?? graph.fallback;
}
async function saveContext(state) {
  await state.storage.saveContext(state.runDir, state.context);
}
function buildSystemPrompt(registry, node) {
  const def = registry[node.agent];
  const optionsPrompt = node.options ? `You MUST end your response with this exact sentinel block, selecting one option:

---CHOICE---
<label>
---END---

Available options: ${Object.keys(node.options).join(" | ")}

Do not invent options. Do not omit the sentinel block.` : undefined;
  return [def.systemPrompt, node.systemPrompt, optionsPrompt].filter(Boolean).join(`

`);
}
var providerCache = new Map;
function findFile(name, subdir, ext) {
  for (const base of SEARCH_DIRS) {
    for (const e of ext.split("|")) {
      const p = join(base, subdir, `${name}.${e}`);
      if (existsSync(p))
        return p;
    }
  }
  return null;
}
async function loadProvider(name) {
  if (providerCache.has(name))
    return providerCache.get(name);
  const path = findFile(name, "providers", "ts|js");
  if (!path)
    throw new Error(`Provider "${name}" not found in any search path: ${SEARCH_DIRS.map((d) => join(d, "providers")).join(", ")}`);
  const mod = await import(path);
  const invoke = mod.invoke ?? mod.default?.invoke;
  if (typeof invoke !== "function")
    throw new Error(`Provider "${name}" must export invoke(ctx)`);
  providerCache.set(name, invoke);
  return invoke;
}
async function loadStorage() {
  const path = findFile("storage", "storage", "ts|js");
  if (!path)
    return filesystemStorage;
  const mod = await import(path);
  const adapter = mod.storage ?? mod.default?.storage;
  if (!adapter)
    return filesystemStorage;
  return { ...filesystemStorage, ...adapter };
}
var VALID_EVENTS = new Set([
  "RunStart",
  "RunEnd",
  "PreAgent",
  "PostAgent",
  "PreProvider",
  "Paused",
  "Resumed",
  "ForkStart",
  "ForkJoin",
  "GuardrailFail",
  "SubworkflowStart",
  "SubworkflowEnd",
  "Error"
]);
var DIRECTIVE_RANK = {
  abort: 5,
  pause: 4,
  redirect: 3,
  skip: 2,
  continue: 1
};
var DIRECTIVE_SUPPORT = {
  abort: new Set(VALID_EVENTS),
  pause: new Set(["PreAgent", "PreProvider", "PostAgent", "GuardrailFail", "SubworkflowStart"]),
  redirect: new Set(["PreAgent", "PreProvider", "PostAgent"]),
  skip: new Set(["PreAgent", "PreProvider"]),
  continue: new Set(VALID_EVENTS)
};
function bootstrapLog(runDir, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] BOOT    ${"hooks".padEnd(22)} ${msg}`;
  appendFileSync(join(runDir, "orchestrator.log"), line + `
`);
  process.stdout.write(line + `
`);
}
async function loadHooks(runDir) {
  const index = new Map;
  for (const name of VALID_EVENTS)
    index.set(name, []);
  const dirs = SEARCH_DIRS.map((d) => join(d, "hooks"));
  const loaded = [];
  for (const dir of dirs) {
    if (!existsSync(dir))
      continue;
    const files = readdirSync(dir).filter((f) => f.endsWith(".ts") || f.endsWith(".js"));
    for (const file of files) {
      const path = join(dir, file);
      try {
        const mod = await import(path);
        const h = mod.hook ?? mod.default?.hook;
        if (!h || typeof h.handler !== "function" || !h.name || !Array.isArray(h.events) || h.events.length === 0) {
          bootstrapLog(runDir, `WARN: skipping ${file} — invalid hook export`);
          continue;
        }
        const hook = {
          name: h.name,
          description: h.description,
          events: h.events.filter((e) => VALID_EVENTS.has(e)),
          parallel: h.parallel ?? true,
          priority: h.priority ?? 50,
          timeout: h.timeout ?? 30000,
          handler: h.handler
        };
        if (hook.events.length === 0) {
          bootstrapLog(runDir, `WARN: skipping ${file} — no valid events`);
          continue;
        }
        for (const evt of hook.events) {
          index.get(evt).push(hook);
        }
        loaded.push(`${hook.name} (${hook.events.join(", ")})`);
      } catch (err) {
        bootstrapLog(runDir, `WARN: failed to load ${file}: ${err}`);
      }
    }
  }
  for (const hooks of index.values()) {
    hooks.sort((a, b) => a.priority - b.priority);
  }
  if (loaded.length > 0)
    bootstrapLog(runDir, `loaded: ${loaded.join(", ")}`);
  else
    bootstrapLog(runDir, "no hooks found");
  return index;
}
async function emitHook(event, payload, state) {
  const hooks = state.hooks.get(event);
  if (!hooks || hooks.length === 0)
    return { action: "continue" };
  const isMutable = event === "PreAgent" || event === "PostAgent";
  const eventObj = {
    event,
    runId: state.runId,
    runDir: state.runDir,
    context: isMutable ? state.context : Object.freeze({ ...state.context }),
    timestamp: Date.now(),
    ...payload
  };
  const directives = [];
  const runOne = async (hook) => {
    try {
      const result = await Promise.race([
        hook.handler(eventObj),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), hook.timeout ?? 30000))
      ]);
      let directive = result;
      if (result.action !== "continue") {
        const supported = DIRECTIVE_SUPPORT[result.action];
        if (!supported?.has(event)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: "${result.action}" not supported for ${event}, treating as continue
`);
          directive = { action: "continue" };
        } else if (result.action === "redirect") {
          const rd = result;
          if (!state.graph.nodes.some((n) => n.id === rd.targetNodeId)) {
            process.stderr.write(`HOOK-WARN ${hook.name}: redirect target "${rd.targetNodeId}" not found, treating as continue
`);
            directive = { action: "continue" };
          }
        }
      }
      directives.push({ directive, priority: hook.priority ?? 50 });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`HOOK-ERR ${hook.name} ${event}: ${msg}
`);
      try {
        appendFileSync(join(state.runDir, "orchestrator.log"), `HOOK-ERR ${hook.name} ${event}: ${msg}
`);
      } catch {}
      directives.push({ directive: { action: "continue" }, priority: hook.priority ?? 50 });
    }
  };
  const sequential = hooks.filter((h) => h.parallel === false);
  for (const hook of sequential)
    await runOne(hook);
  const parallel = hooks.filter((h) => h.parallel !== false);
  if (parallel.length > 0)
    await Promise.all(parallel.map(runOne));
  let winner = { directive: { action: "continue" }, priority: 100 };
  for (const d of directives) {
    const dRank = DIRECTIVE_RANK[d.directive.action] ?? 1;
    const wRank = DIRECTIVE_RANK[winner.directive.action] ?? 1;
    if (dRank > wRank || dRank === wRank && d.priority < winner.priority) {
      winner = d;
    }
  }
  return winner.directive;
}
async function invokeAgent(node, state, precomputed) {
  const def = state.registry[node.agent];
  const command = state.overrides.provider ?? def.command;
  const model = state.overrides.model ?? def.model;
  const userPrompt = precomputed?.userPrompt ?? renderUserPrompt(sliceContext(state.context, node.slice), node.instruction);
  const sysPrompt = precomputed?.systemPrompt ?? buildSystemPrompt(state.registry, node);
  const cwd = resolve(state.context[`_worktree:${node.id}`] ?? node.cwd ?? process.cwd());
  const logFile = state.storage.logPath(state.runDir, node.id);
  const agentTimeout = node.timeout ?? 600000;
  const invoke = await loadProvider(command);
  const result = await Promise.race([
    invoke({ userPrompt, systemPrompt: sysPrompt, options: Object.keys(node.options ?? {}), cwd, model, logFile }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Agent timeout after ${agentTimeout}ms on node "${node.id}"`)), agentTimeout))
  ]);
  return result;
}
function evalGuardrail(g, ctx) {
  if (typeof g === "function")
    return g(ctx);
  if (g.nodeId && g.nodeId !== ctx.nodeId)
    return { pass: true };
  try {
    const { output = "", choice = "", nodeId, context } = ctx;
    const esmRequire = createRequire2(import.meta.url);
    const pass = new Function("output", "choice", "nodeId", "context", "require", `"use strict"; return !!(${g.check})`)(output, choice, nodeId, context, esmRequire);
    return pass ? { pass: true } : { pass: false, reason: g.reason };
  } catch (err) {
    return { pass: false, reason: `guardrail eval error: ${err}` };
  }
}
function runGuardrails(checks, ctx) {
  for (const check of checks) {
    const result = evalGuardrail(check, ctx);
    if (!result.pass)
      return result;
  }
  return { pass: true };
}
async function errorFallback(state, nodeId, node, error) {
  const fallback = resolveFallback(node, state.graph);
  await emitHook("Error", { nodeId, error, fallbackNodeId: fallback }, state);
  return executeNode(fallback, nodeId, state);
}
async function applyDirective(d, state, nodeId, node, fromNodeId) {
  if (d.action === "abort")
    throw new Error(`Aborted by hook: ${d.reason}`);
  if (d.action === "pause") {
    await writePause(state, nodeId, fromNodeId, d.reason);
    return true;
  }
  if (d.action === "redirect") {
    await executeNode(d.targetNodeId, nodeId, state);
    return true;
  }
  if (d.action === "skip") {
    await executeNode(resolveFallback(node, state.graph), nodeId, state);
    return true;
  }
}
async function writePause(state, nodeId, fromNodeId, reason) {
  const paused = {
    runId: state.runId,
    nodeId: fromNodeId ?? nodeId,
    context: state.context,
    agentOutput: state.context[fromNodeId ?? ""] ?? "",
    reason,
    iterationCounts: Object.fromEntries(state.iterationCounts)
  };
  await state.storage.savePause(state.runDir, paused);
  await saveContext(state);
  const stateFile = join(state.runDir, "state.json");
  await emitHook("Paused", { nodeId, reason, stateFile }, state);
}
async function executeNode(nodeId, fromNodeId, state) {
  const { graph, context, joinMap, runDir } = state;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node)
    throw new Error(`Node not found: "${nodeId}"`);
  if (node.type === "done") {
    await emitHook("RunEnd", { terminal: "done", finalContext: context }, state);
    return;
  }
  if (node.type === "failed") {
    await emitHook("RunEnd", { terminal: "failed", finalContext: context }, state);
    throw new Error("Graph reached failed terminal");
  }
  if (node.type === "paused") {
    await writePause(state, nodeId, fromNodeId);
    return;
  }
  if (node.type === "fork") {
    const directive = await emitHook("ForkStart", { nodeId, targets: node.targets }, state);
    if (directive.action === "abort")
      throw new Error(`Aborted by hook: ${directive.reason}`);
    await Promise.all(node.targets.map((t) => executeNode(t, nodeId, state)));
    await emitHook("ForkJoin", { nodeId, joinedFrom: node.targets }, state);
    return;
  }
  if (node.type === "join") {
    if (!joinMap.has(nodeId))
      joinMap.set(nodeId, new Set);
    const arrived = joinMap.get(nodeId);
    if (fromNodeId)
      arrived.add(fromNodeId);
    if (arrived.size < node.waits_for.length)
      return;
  }
  if (node.type === "subworkflow") {
    const raw = context[node.source];
    if (!raw)
      return errorFallback(state, nodeId, node, `source "${node.source}" not in context`);
    let inner;
    try {
      inner = JSON.parse(raw);
    } catch (err) {
      return errorFallback(state, nodeId, node, `bad workflow JSON: ${err}`);
    }
    const importPath = resolve("supertinker.ts").replace(/\.ts$/, "");
    const tsContent = `import type { Workflow } from "${importPath}";

export const workflow: Workflow = ${JSON.stringify(inner, null, 2)};
`;
    const workflowFile = `${inner.id}.workflow.ts`;
    await state.storage.saveFile(runDir, workflowFile, tsContent);
    await emitHook("SubworkflowStart", { nodeId, innerWorkflow: inner }, state);
    const innerRunDir = await state.storage.createRun(`${state.runId}/sub-${inner.id}`);
    const innerContext = {};
    for (const key of node.slice ?? Object.keys(context))
      if (key in context && key !== node.source)
        innerContext[key] = context[key];
    if (node.cwd) {
      const cwd = resolve(node.cwd);
      inner = { ...inner, graph: { ...inner.graph, nodes: inner.graph.nodes.map((n) => !n.cwd && n.agent ? { ...n, cwd } : n) } };
    }
    const innerState = {
      runId: `${state.runId}/${inner.id}`,
      runDir: innerRunDir,
      context: innerContext,
      joinMap: new Map,
      iterationCounts: new Map,
      graph: inner.graph,
      registry: inner.registry,
      guardrails: {
        maxIterations: inner.guardrails?.maxIterations ?? state.guardrails.maxIterations,
        pre: [...state.guardrails.pre ?? [], ...inner.guardrails?.pre ?? []],
        post: [...state.guardrails.post ?? [], ...inner.guardrails?.post ?? []]
      },
      overrides: state.overrides,
      hooks: state.hooks,
      storage: state.storage
    };
    try {
      await executeNode(inner.graph.start, null, innerState);
    } catch (err) {
      return errorFallback(state, nodeId, node, String(err));
    }
    context[nodeId] = JSON.stringify(innerState.context);
    await saveContext(state);
    await state.storage.saveWorkflow(inner.id, readFileSync(join(runDir, workflowFile), "utf8"));
    await emitHook("SubworkflowEnd", { nodeId, innerContext: innerState.context }, state);
    const next = node.options?.["done"];
    if (next)
      return executeNode(next, nodeId, state);
    return;
  }
  const { guardrails, iterationCounts } = state;
  const count = (iterationCounts.get(nodeId) ?? 0) + 1;
  iterationCounts.set(nodeId, count);
  if (guardrails.maxIterations && count > guardrails.maxIterations)
    return writePause(state, nodeId, fromNodeId, `node "${nodeId}" exceeded max iterations (${guardrails.maxIterations})`);
  if (guardrails.pre?.length) {
    const pre = runGuardrails(guardrails.pre, { context, nodeId });
    if (!pre.pass) {
      const reason = pre.reason;
      await emitHook("GuardrailFail", { nodeId, phase: "pre", reason }, state);
      return writePause(state, nodeId, fromNodeId, `pre-guardrail: ${reason}`);
    }
  }
  const sliced = sliceContext(context, node.slice);
  const userPrompt = renderUserPrompt(sliced, node.instruction);
  const sysPrompt = buildSystemPrompt(state.registry, node);
  const def = state.registry[node.agent];
  const command = state.overrides.provider ?? def.command;
  const model = state.overrides.model ?? def.model;
  const preDirective = await emitHook("PreAgent", {
    nodeId,
    agent: node.agent,
    provider: command,
    userPrompt,
    systemPrompt: sysPrompt,
    slicedContext: sliced
  }, state);
  if (await applyDirective(preDirective, state, nodeId, node, fromNodeId))
    return;
  const logFile = state.storage.logPath(state.runDir, node.id);
  const preProviderDirective = await emitHook("PreProvider", {
    nodeId,
    agent: node.agent,
    provider: command,
    userPrompt,
    systemPrompt: sysPrompt,
    cwd: resolve(node.cwd ?? process.cwd()),
    model,
    logFile
  }, state);
  if (await applyDirective(preProviderDirective, state, nodeId, node, fromNodeId))
    return;
  let result;
  try {
    result = await invokeAgent(node, state, { userPrompt, systemPrompt: sysPrompt });
  } catch (err) {
    return errorFallback(state, nodeId, node, String(err));
  }
  const postDirective = await emitHook("PostAgent", {
    nodeId,
    agent: node.agent,
    provider: command,
    result,
    transcriptPath: result.transcriptPath
  }, state);
  if (await applyDirective(postDirective, state, nodeId, node, fromNodeId))
    return;
  if (guardrails.post?.length) {
    const post = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice });
    if (!post.pass) {
      const postReason = post.reason;
      await emitHook("GuardrailFail", { nodeId, phase: "post", reason: postReason }, state);
      const retryNode = { ...node, instruction: `${node.instruction ?? ""}

GUARDRAIL FEEDBACK: ${postReason}
Fix the issue and try again.` };
      try {
        result = await invokeAgent(retryNode, state);
      } catch (err) {
        return writePause(state, nodeId, fromNodeId, `post-guardrail: ${postReason} (retry failed)`);
      }
      const post2 = runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice });
      if (!post2.pass) {
        const post2Reason = post2.reason;
        await emitHook("GuardrailFail", { nodeId, phase: "post", reason: post2Reason }, state);
        return writePause(state, nodeId, fromNodeId, `post-guardrail: ${post2Reason} (after retry)`);
      }
    }
  }
  const nextNodeId = node.options?.[result.choice];
  if (!nextNodeId)
    return errorFallback(state, nodeId, node, `choice "${result.choice}" not declared`);
  context[nodeId] = result.output;
  await saveContext(state);
  return executeNode(nextNodeId, nodeId, state);
}
async function buildCatalog(storage) {
  const s = storage ?? await loadStorage();
  const entries = await s.listWorkflows();
  if (entries.length === 0)
    return "No workflows available.";
  const lines = entries.map((e) => `- ${e.id}: ${e.description} [${e.source}: ${e.file}]`);
  return `Available workflows (${entries.length}):
${lines.join(`
`)}`;
}
async function run({ workflow, initialContext = {}, overrides = {} }) {
  const { graph, registry } = workflow;
  const storage = await loadStorage();
  const runId = `${workflow.id}-${Date.now()}`;
  const runDir = await storage.createRun(runId);
  const hooks = await loadHooks(runDir);
  const state = {
    runId,
    runDir,
    context: { ...initialContext },
    joinMap: new Map,
    iterationCounts: new Map,
    graph,
    registry,
    guardrails: workflow.guardrails ?? {},
    hooks,
    storage,
    overrides
  };
  const startDirective = await emitHook("RunStart", { workflow, initialContext }, state);
  if (startDirective.action === "abort") {
    throw new Error(`Aborted by hook: ${startDirective.reason}`);
  }
  await executeNode(graph.start, null, state);
}
async function resume({ workflow, runId, choice, overrides = {} }) {
  const { graph, registry } = workflow;
  const storage = await loadStorage();
  const runDir = join("/tmp/orchestrator", runId);
  if (!await storage.pauseExists(runDir))
    throw new Error(`No paused state for run: ${runId}`);
  const paused = await storage.loadPause(runDir);
  const hooks = await loadHooks(runDir);
  const fromNode = graph.nodes.find((n) => n.id === paused.nodeId);
  if (!fromNode?.options?.[choice])
    throw new Error(`Choice "${choice}" not valid for "${paused.nodeId}". Options: ${Object.keys(fromNode?.options ?? {})}`);
  const restoredIterations = new Map(Object.entries(paused.iterationCounts ?? {}));
  const state = {
    runId,
    runDir,
    context: paused.context,
    joinMap: new Map,
    iterationCounts: restoredIterations,
    graph,
    registry,
    guardrails: workflow.guardrails ?? {},
    hooks,
    storage,
    overrides
  };
  const resumeDirective = await emitHook("Resumed", { nodeId: paused.nodeId, choice }, state);
  if (resumeDirective.action === "abort") {
    throw new Error(`Aborted by hook: ${resumeDirective.reason}`);
  }
  await executeNode(fromNode.options[choice], paused.nodeId, state);
}

// ../../../../private/tmp/supertinker-entry-XXXX.ts
var EMBEDDED = { "providers/claude.ts": `import { spawn } from "child_process"
import { appendFileSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"
import type { DisplayEvent, TranscriptMapper } from "../display-protocol.js"

interface ProviderContext {
  userPrompt:   string
  systemPrompt: string
  options:      string[]
  cwd:          string
  model?:       string
  logFile:      string
}

interface AgentResult {
  output: string
  choice: string
  transcriptPath?: string
}

function run(command: string, args: string[], cwd: string, logFile: string): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(command, args, { cwd, env: process.env, detached: true, stdio: ["pipe", "pipe", "pipe"] })
    proc.unref()
    let out = "", err = ""
    proc.stdout.on("data", (chunk: Buffer) => {
      const txt = chunk.toString(); out += txt
      appendFileSync(logFile, txt)
    })
    proc.stderr.on("data", (chunk: Buffer) => { err += chunk.toString() })
    proc.on("close", code => code === 0 ? res(out) : rej(new Error(\`exit \${code}: \${err.slice(0, 300)}\`)))
    proc.stdin.end()
  })
}

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const schema = JSON.stringify({
    type: "object",
    required: ["output", "choice"],
    properties: {
      output: { type: "string" },
      choice: { type: "string", enum: ctx.options },
    },
  })

  const sessionId = randomUUID()

  // Write meta sidecar for dashboard
  // Find the transcript by searching for the sessionId.jsonl file across Claude project dirs
  const claudeProjects = \`\${process.env.HOME}/.claude/projects\`
  const metaPath = ctx.logFile.replace(/\\.log$/, ".meta.json")
  const transcriptFile = \`\${sessionId}.jsonl\`

  // Write initial meta with a glob pattern \u2014 dashboard will resolve it
  writeFileSync(metaPath, JSON.stringify({ transcriptFile, sessionId, claudeProjects, provider: "claude" }))

  const args = [
    "-p", ctx.userPrompt,
    "--system-prompt", ctx.systemPrompt,
    "--output-format", "json",
    "--json-schema", schema,
    "--dangerously-skip-permissions",
    "--session-id", sessionId,
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  const raw = await run("claude", args, ctx.cwd, ctx.logFile)

  const parsed = JSON.parse(raw.trim())
  let result: AgentResult
  if (parsed.output !== undefined && parsed.choice !== undefined) result = parsed
  else if (parsed.structured_output?.output !== undefined && parsed.structured_output?.choice !== undefined) result = parsed.structured_output
  else if (parsed.result) result = JSON.parse(parsed.result)
  else throw new Error(\`Unexpected Claude output shape: \${raw.slice(0, 200)}\`)

  result.transcriptPath = parsed.session_id
    ? \`\${sessionId}.jsonl\`
    : undefined

  return result
}

export const mapTranscript: TranscriptMapper = (line: string) => {
  let parsed: any
  try { parsed = JSON.parse(line) } catch { return null }

  const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now()

  // Skip non-display events
  if (parsed.type === "queue-operation" || parsed.type === "attachment" || parsed.type === "system") return null

  // User events \u2014 look for tool_result
  if (parsed.type === "user" && Array.isArray(parsed.message?.content)) {
    const events: DisplayEvent[] = []
    for (const block of parsed.message.content) {
      if (block.type === "tool_result") {
        const result = typeof block.content === "string"
          ? block.content
          : Array.isArray(block.content)
            ? block.content.map((b: any) => b.text ?? "").join("").slice(0, 200)
            : "(result)"
        events.push({
          t: "tool_end",
          ts,
          id: block.tool_use_id ?? "",
          name: "",
          result: result.slice(0, 200),
        })
      }
    }
    return events.length > 0 ? events : null
  }

  // Assistant events
  if (parsed.type === "assistant" && Array.isArray(parsed.message?.content)) {
    const events: DisplayEvent[] = []
    for (const block of parsed.message.content) {
      if (block.type === "thinking" && block.thinking) {
        events.push({ t: "thinking", ts, text: block.thinking })
      }
      if (block.type === "text" && block.text) {
        events.push({
          t: "text",
          ts,
          text: block.text,
          final: parsed.message.stop_reason !== null,
        })
      }
      if (block.type === "tool_use") {
        const args: Record<string, string> = {}
        if (block.input) {
          for (const [k, v] of Object.entries(block.input)) {
            const s = typeof v === "string" ? v : JSON.stringify(v)
            args[k] = s.length > 100 ? s.slice(0, 100) + "..." : s
          }
        }
        events.push({
          t: "tool_start",
          ts,
          id: block.id ?? "",
          name: block.name ?? "",
          args,
        })
      }
    }
    return events.length > 0 ? events : null
  }

  return null
}
` };
var BUILD_STAMP = "2026-04-16T15:23:11.800Z";
var userDir = join2(homedir2(), ".supertinker");
var stampFile = join2(userDir, ".builtin-stamp");
var needsExtract = !existsSync2(stampFile) || readFileSync2(stampFile, "utf8").trim() !== BUILD_STAMP;
if (needsExtract) {
  for (const [relPath, content] of Object.entries(EMBEDDED)) {
    const abs = join2(userDir, relPath);
    mkdirSync2(join2(abs, ".."), { recursive: true });
    writeFileSync2(abs, content);
  }
  mkdirSync2(userDir, { recursive: true });
  writeFileSync2(stampFile, BUILD_STAMP);
}
var argv = process.argv.slice(2);
var cmd = argv[0];
var get = (flag) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : undefined;
};
async function main() {
  if (cmd === "run") {
    const workflowRef = get("--workflow") ?? "meta";
    const prompt = get("--prompt");
    const provider = get("--provider");
    const model = get("--model");
    const overrides = { ...provider && { provider }, ...model && { model } };
    const storage = await loadStorage();
    const workflowPath = await storage.resolveWorkflow(workflowRef) ?? resolve2(workflowRef);
    const { workflow } = await import(workflowPath);
    const initialContext = { catalog: await buildCatalog(storage), cwd: process.cwd() };
    if (prompt)
      initialContext.task = prompt;
    await run({ workflow, initialContext, overrides });
    return;
  }
  if (cmd === "resume") {
    const runId = get("--run"), choice = get("--choice"), workflowRef = get("--workflow");
    const provider = get("--provider"), model = get("--model");
    const overrides = { ...provider && { provider }, ...model && { model } };
    if (!runId || !choice || !workflowRef) {
      console.error("Usage: supertinker resume --run <id> --choice <label> --workflow <name|path>");
      process.exit(1);
    }
    const storage = await loadStorage();
    const { workflow } = await import(await storage.resolveWorkflow(workflowRef) ?? resolve2(workflowRef));
    await resume({ workflow, runId, choice, overrides });
    return;
  }
  if (cmd === "list") {
    const storage = await loadStorage();
    console.log(await buildCatalog(storage));
    return;
  }
  if (cmd === "plugins") {
    const { execSync } = await import("child_process");
    const cliPath = resolve2("/Users/gpavanello/Repositories/supertinker", "cli.ts");
    const raw = process.argv.slice(2);
    const escaped = raw.map(function(s) {
      return "'" + s.replace(/'/g, "'\\''") + "'";
    }).join(" ");
    try {
      execSync("tsx " + cliPath + " " + escaped, { stdio: "inherit", cwd: process.cwd() });
    } catch (e) {
      if (e.status)
        process.exit(e.status);
    }
    return;
  }
  console.log(`supertinker \u2014 minimal agent orchestrator

Commands:
  run       [--workflow <name|path>] --prompt <text> [--provider <name>] [--model <name>]
  resume    --run <runId> --choice <label> --workflow <name|path>
  list             show available workflows
  plugins list     show available/installed plugins
  plugins install  install plugins
  plugins update   pull latest + re-copy installed

Examples:
  supertinker run --prompt "Build a REST API"
  supertinker plugins list
  supertinker plugins install logger fork-worktree --global`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
