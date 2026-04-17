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
  statSync,
  writeFileSync
} from "fs";
import { join, resolve } from "path";
import { homedir } from "os";
import { createRequire as createRequire2 } from "module";
var BUILTIN_DIR = resolve(join(new URL(import.meta.url).pathname, ".."));
var USER_DIR = join(homedir(), ".supertinker");
var PROJECT_DIR = join(process.cwd(), ".supertinker");
var SEARCH_DIRS = [PROJECT_DIR, USER_DIR, BUILTIN_DIR];
var RUN_ROOT = "/tmp/orchestrator";
var filesystemStorage = {
  async createRun(runId) {
    const dir = join(RUN_ROOT, runId);
    mkdirSync(dir, { recursive: true });
    return dir;
  },
  runDir(runId) {
    const direct = join(RUN_ROOT, runId);
    if (existsSync(direct))
      return direct;
    if (runId.includes("/")) {
      const [head, ...rest] = runId.split("/");
      const subPath = join(RUN_ROOT, head, `sub-${rest.join("/")}`);
      if (existsSync(subPath))
        return subPath;
    }
    return direct;
  },
  async listRuns({ sinceMs = 0 } = {}) {
    if (!existsSync(RUN_ROOT))
      return [];
    const out = [];
    for (const name of readdirSync(RUN_ROOT)) {
      try {
        const s = statSync(join(RUN_ROOT, name));
        if (s.isDirectory() && s.mtimeMs >= sinceMs)
          out.push({ runId: name, mtimeMs: s.mtimeMs });
      } catch {}
    }
    return out;
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
  async readFile(runDir, name) {
    const path = join(runDir, name);
    return existsSync(path) ? readFileSync(path, "utf8") : null;
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
    for (const { path, file, source } of walkPluginFiles("workflows", [".workflow.ts"])) {
      try {
        const raw = readFileSync(path, "utf8");
        const id = raw.match(/(?:"id"|id)\s*:\s*"([^"]+)"/)?.[1] ?? file;
        const description = raw.match(/(?:"description"|description)\s*:\s*"([^"]+)"/)?.[1] ?? "(no description)";
        entries.push({ id, description, file, source });
      } catch {}
    }
    return entries;
  }
};
function* walkPluginFiles(subdir, exts) {
  const sources = [
    [PROJECT_DIR, "project"],
    [USER_DIR, "user"],
    [BUILTIN_DIR, "built-in"]
  ];
  for (const [base, source] of sources) {
    const dir = join(base, subdir);
    if (!existsSync(dir))
      continue;
    let files;
    try {
      files = readdirSync(dir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (!exts.some((e) => file.endsWith(e)))
        continue;
      yield { path: join(dir, file), file, source };
    }
  }
}
var BUILTIN_HOOK_EVENTS = [
  "RunStart",
  "RunEnd",
  "NodeStart",
  "NodeEnd",
  "PreAgent",
  "PostAgent",
  "PartialAgent",
  "PreProvider",
  "Paused",
  "Resumed",
  "ForkStart",
  "ForkJoin",
  "GuardrailFail",
  "SubworkflowStart",
  "SubworkflowEnd",
  "Error"
];
var BUILTIN_NODE_TYPES = new Set([
  "fork",
  "join",
  "done",
  "failed",
  "paused",
  "subworkflow"
]);
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
async function readNodeTypePlugins() {
  const out = [];
  for (const { path, file, source } of walkPluginFiles("nodes", [".ts", ".js"])) {
    try {
      const mod = await import(path);
      const def = mod.node ?? mod.default?.node;
      if (!def || typeof def.execute !== "function" || !def.type)
        continue;
      out.push({ def, source, file });
    } catch {}
  }
  return out;
}
async function loadNodeTypes(runDir) {
  const registry = new Map;
  const loaded = [];
  for (const { def, file } of await readNodeTypePlugins()) {
    if (BUILTIN_NODE_TYPES.has(def.type)) {
      bootstrapLog(runDir, "node-types", `WARN: skipping ${file} — node type "${def.type}" shadows a built-in`);
      continue;
    }
    if (registry.has(def.type))
      continue;
    registry.set(def.type, def);
    loaded.push(def.type);
  }
  bootstrapLog(runDir, "node-types", loaded.length > 0 ? `loaded: ${loaded.join(", ")}` : "no custom node types found");
  return registry;
}
var VALID_EVENTS = new Set(BUILTIN_HOOK_EVENTS);
var DIRECTIVE_RANK = {
  abort: 5,
  pause: 4,
  redirect: 3,
  skip: 2,
  continue: 1,
  rewrite: 0
};
var DIRECTIVE_SUPPORT = {
  abort: new Set(VALID_EVENTS),
  pause: new Set(["PreAgent", "PreProvider", "PostAgent", "GuardrailFail", "SubworkflowStart", "NodeStart"]),
  redirect: new Set(["PreAgent", "PreProvider", "PostAgent"]),
  skip: new Set(["PreAgent", "PreProvider"]),
  continue: new Set(VALID_EVENTS),
  rewrite: new Set(["PreAgent", "PreProvider", "PostAgent"])
};
var REWRITE_ALLOWED = {
  PreAgent: new Set(["userPrompt", "systemPrompt"]),
  PreProvider: new Set(["userPrompt", "systemPrompt", "model", "cwd"]),
  PostAgent: new Set(["output", "choice", "metadata"])
};
function bootstrapLog(runDir, label, msg) {
  const line = `[${new Date().toISOString().slice(11, 19)}] BOOT    ${label.padEnd(22)} ${msg}`;
  appendFileSync(join(runDir, "orchestrator.log"), line + `
`);
  process.stdout.write(line + `
`);
}
async function loadHooks(runDir) {
  const index = new Map;
  for (const name of VALID_EVENTS)
    index.set(name, []);
  const loaded = [];
  for (const { path, file } of walkPluginFiles("hooks", [".ts", ".js"])) {
    try {
      const mod = await import(path);
      const h = mod.hook ?? mod.default?.hook;
      const events = Array.isArray(h?.events) ? h.events.filter((e) => typeof e === "string" && e.length > 0) : [];
      if (!h || typeof h.handler !== "function" || !h.name || events.length === 0) {
        bootstrapLog(runDir, "hooks", `WARN: skipping ${file} — invalid hook export`);
        continue;
      }
      const hook = {
        name: h.name,
        description: h.description,
        events,
        parallel: h.parallel ?? true,
        priority: h.priority ?? 50,
        timeout: h.timeout ?? 30000,
        handler: h.handler
      };
      for (const evt of hook.events) {
        if (!index.has(evt))
          index.set(evt, []);
        index.get(evt).push(hook);
      }
      loaded.push(`${hook.name} (${hook.events.join(", ")})`);
    } catch (err) {
      bootstrapLog(runDir, "hooks", `WARN: failed to load ${file}: ${err}`);
    }
  }
  for (const hooks of index.values())
    hooks.sort((a, b) => a.priority - b.priority);
  bootstrapLog(runDir, "hooks", loaded.length > 0 ? `loaded: ${loaded.join(", ")}` : "no hooks found");
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
  const isBuiltinEvent = VALID_EVENTS.has(event);
  const allowedKeys = REWRITE_ALLOWED[event];
  const directives = [];
  const cumulativePatch = {};
  const filterPatch = (hookName, patch) => {
    if (!allowedKeys) {
      process.stderr.write(`HOOK-WARN ${hookName}: "rewrite" not supported for ${event}, treating as continue
`);
      return {};
    }
    const out = {};
    for (const [k, v] of Object.entries(patch)) {
      if (allowedKeys.has(k))
        out[k] = v;
      else
        process.stderr.write(`HOOK-WARN ${hookName}: rewrite key "${k}" not allowed for ${event}, dropped
`);
    }
    return out;
  };
  const runOne = async (hook, sequential) => {
    try {
      const result = await Promise.race([
        hook.handler(eventObj),
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), hook.timeout ?? 30000))
      ]);
      let directive = result;
      if (result.action === "rewrite") {
        const supported = DIRECTIVE_SUPPORT.rewrite;
        if (isBuiltinEvent && !supported?.has(event)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: "rewrite" not supported for ${event}, treating as continue
`);
          directive = { action: "continue" };
        } else {
          const filtered = filterPatch(hook.name, result.patch ?? {});
          Object.assign(cumulativePatch, filtered);
          if (sequential)
            Object.assign(eventObj, filtered);
          directive = { action: "continue" };
        }
      } else if (result.action !== "continue") {
        const supported = DIRECTIVE_SUPPORT[result.action];
        if (isBuiltinEvent && !supported?.has(event)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: "${result.action}" not supported for ${event}, treating as continue
`);
          directive = { action: "continue" };
        } else if (result.action === "redirect" && !state.graph.nodes.some((n) => n.id === result.targetNodeId)) {
          process.stderr.write(`HOOK-WARN ${hook.name}: redirect target "${result.targetNodeId}" not found, treating as continue
`);
          directive = { action: "continue" };
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
  for (const hook of hooks)
    if (hook.parallel === false)
      await runOne(hook, true);
  const parallel = hooks.filter((h) => h.parallel !== false);
  if (parallel.length > 0)
    await Promise.all(parallel.map((h) => runOne(h, false)));
  let winner = { directive: { action: "continue" }, priority: 100 };
  for (const d of directives) {
    const dRank = DIRECTIVE_RANK[d.directive.action] ?? 1;
    const wRank = DIRECTIVE_RANK[winner.directive.action] ?? 1;
    if (dRank > wRank || dRank === wRank && d.priority < winner.priority)
      winner = d;
  }
  if (winner.directive.action === "continue" && Object.keys(cumulativePatch).length > 0) {
    return { action: "rewrite", patch: cumulativePatch };
  }
  return winner.directive;
}
function abortIfHook(d) {
  if (d.action === "abort")
    throw new Error(`Aborted by hook: ${d.reason}`);
}
async function invokeAgent(node, state, precomputed) {
  const def = state.registry[node.agent];
  const command = state.overrides.provider ?? def.command;
  const model = precomputed?.model ?? state.overrides.model ?? def.model;
  const userPrompt = precomputed?.userPrompt ?? renderUserPrompt(sliceContext(state.context, node.slice), node.instruction);
  const sysPrompt = precomputed?.systemPrompt ?? buildSystemPrompt(state.registry, node);
  const cwd = resolve(precomputed?.cwd ?? state.context[`_worktree:${node.id}`] ?? node.cwd ?? process.cwd());
  const logFile = state.storage.logPath(state.runDir, node.id);
  const agentTimeout = node.timeout ?? 600000;
  const invoke = await loadProvider(command);
  return Promise.race([
    invoke({ userPrompt, systemPrompt: sysPrompt, options: Object.keys(node.options ?? {}), cwd, model, logFile, onChunk: precomputed?.onChunk, signal: precomputed?.signal }),
    new Promise((_, rej) => setTimeout(() => rej(new Error(`Agent timeout after ${agentTimeout}ms on node "${node.id}"`)), agentTimeout))
  ]);
}
async function runAgentPipeline(node, state, fromNodeId) {
  if (!node.agent)
    throw new Error(`runAgent called without agent on node "${node.id}"`);
  const sliced = sliceContext(state.context, node.slice);
  let userPrompt = renderUserPrompt(sliced, node.instruction);
  let sysPrompt = buildSystemPrompt(state.registry, node);
  const def = state.registry[node.agent];
  const command = state.overrides.provider ?? def.command;
  let model = state.overrides.model ?? def.model;
  let cwd = resolve(node.cwd ?? process.cwd());
  const pre = await emitHook("PreAgent", {
    nodeId: node.id,
    agent: node.agent,
    provider: command,
    userPrompt,
    systemPrompt: sysPrompt,
    slicedContext: sliced
  }, state);
  if (pre.action === "rewrite") {
    if (typeof pre.patch.userPrompt === "string")
      userPrompt = pre.patch.userPrompt;
    if (typeof pre.patch.systemPrompt === "string")
      sysPrompt = pre.patch.systemPrompt;
  } else if (await applyDirective(pre, state, node, fromNodeId))
    return { redirected: true };
  const logFile = state.storage.logPath(state.runDir, node.id);
  const preProv = await emitHook("PreProvider", {
    nodeId: node.id,
    agent: node.agent,
    provider: command,
    userPrompt,
    systemPrompt: sysPrompt,
    cwd,
    model,
    logFile
  }, state);
  if (preProv.action === "rewrite") {
    if (typeof preProv.patch.userPrompt === "string")
      userPrompt = preProv.patch.userPrompt;
    if (typeof preProv.patch.systemPrompt === "string")
      sysPrompt = preProv.patch.systemPrompt;
    if (typeof preProv.patch.model === "string")
      model = preProv.patch.model;
    if (typeof preProv.patch.cwd === "string")
      cwd = preProv.patch.cwd;
  } else if (await applyDirective(preProv, state, node, fromNodeId))
    return { redirected: true };
  const ac = new AbortController;
  let totalChars = 0;
  const onChunk = (chunk) => {
    totalChars += chunk.length;
    emitHook("PartialAgent", {
      nodeId: node.id,
      agent: node.agent,
      provider: command,
      chunk,
      totalChars
    }, state).then((d) => {
      if (d.action === "abort")
        ac.abort(new Error(`Aborted by hook: ${d.reason}`));
    }).catch(() => {});
  };
  const result = await invokeAgent(node, state, { userPrompt, systemPrompt: sysPrompt, model, cwd, onChunk, signal: ac.signal });
  const post = await emitHook("PostAgent", {
    nodeId: node.id,
    agent: node.agent,
    provider: command,
    result,
    transcriptPath: result.transcriptPath
  }, state);
  if (post.action === "rewrite") {
    if (typeof post.patch.output === "string")
      result.output = post.patch.output;
    if (typeof post.patch.choice === "string")
      result.choice = post.patch.choice;
    if (post.patch.metadata && typeof post.patch.metadata === "object") {
      result.metadata = { ...result.metadata ?? {}, ...post.patch.metadata };
    }
  } else if (await applyDirective(post, state, node, fromNodeId))
    return { redirected: true };
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
  for (const g of checks) {
    const result = evalGuardrail(g, ctx);
    if (!result.pass)
      return result.reason;
  }
  return null;
}
async function errorFallback(state, nodeId, node, error) {
  const fallback = resolveFallback(node, state.graph);
  await emitHook("Error", { nodeId, error, fallbackNodeId: fallback }, state);
  return executeNode(fallback, nodeId, state);
}
async function applyDirective(d, state, node, fromNodeId) {
  if (d.action === "continue")
    return false;
  if (d.action === "abort")
    throw new Error(`Aborted by hook: ${d.reason}`);
  if (d.action === "pause")
    await writePause(state, node.id, fromNodeId, d.reason);
  if (d.action === "redirect")
    await executeNode(d.targetNodeId, node.id, state);
  if (d.action === "skip")
    await executeNode(resolveFallback(node, state.graph), node.id, state);
  return true;
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
  await emitHook("Paused", { nodeId, reason, stateFile: join(state.runDir, "state.json") }, state);
}
async function executeNode(nodeId, fromNodeId, state) {
  const { graph, context, joinMap, runDir } = state;
  const node = graph.nodes.find((n) => n.id === nodeId);
  if (!node)
    throw new Error(`Node not found: "${nodeId}"`);
  const nodeType = node.type ?? "standard";
  const nodeEnd = (to) => emitHook("NodeEnd", { nodeId, nodeType, to }, state);
  const startDirective = await emitHook("NodeStart", { nodeId, nodeType, from: fromNodeId }, state);
  abortIfHook(startDirective);
  if (startDirective.action === "pause") {
    await writePause(state, nodeId, fromNodeId, startDirective.reason);
    return;
  }
  if (node.type === "done" || node.type === "failed" || node.type === "paused") {
    await nodeEnd(null);
    if (node.type === "paused")
      return writePause(state, nodeId, fromNodeId);
    await emitHook("RunEnd", { terminal: node.type, finalContext: context }, state);
    if (node.type === "failed")
      throw new Error("Graph reached failed terminal");
    return;
  }
  if (node.type === "fork") {
    abortIfHook(await emitHook("ForkStart", { nodeId, targets: node.targets }, state));
    await Promise.all(node.targets.map((t) => executeNode(t, nodeId, state)));
    await emitHook("ForkJoin", { nodeId, joinedFrom: node.targets }, state);
    await nodeEnd(null);
    return;
  }
  if (node.type === "join") {
    if (!joinMap.has(nodeId))
      joinMap.set(nodeId, new Set);
    const arrived = joinMap.get(nodeId);
    if (fromNodeId)
      arrived.add(fromNodeId);
    if (arrived.size < node.waits_for.length) {
      await nodeEnd(null);
      return;
    }
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
      ...state,
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
      }
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
    await nodeEnd(next ?? null);
    if (next)
      return executeNode(next, nodeId, state);
    return;
  }
  if (node.type && !BUILTIN_NODE_TYPES.has(node.type)) {
    const def = state.nodeTypes.get(node.type);
    if (!def)
      return errorFallback(state, nodeId, node, `unknown node.type "${node.type}" — no built-in handler and no plugin in <search>/nodes/`);
    if (def.validate) {
      const err = def.validate(node, state.graph);
      if (err)
        return errorFallback(state, nodeId, node, `node-type validation: ${err}`);
    }
    try {
      await def.execute(buildNodeExecuteCtx(node, fromNodeId, state));
    } catch (err) {
      return errorFallback(state, nodeId, node, String(err));
    }
    await nodeEnd(null);
    return;
  }
  const { guardrails, iterationCounts } = state;
  const count = (iterationCounts.get(nodeId) ?? 0) + 1;
  iterationCounts.set(nodeId, count);
  if (guardrails.maxIterations && count > guardrails.maxIterations)
    return writePause(state, nodeId, fromNodeId, `node "${nodeId}" exceeded max iterations (${guardrails.maxIterations})`);
  if (guardrails.pre?.length) {
    const preReason = runGuardrails(guardrails.pre, { context, nodeId });
    if (preReason) {
      await emitHook("GuardrailFail", { nodeId, phase: "pre", reason: preReason }, state);
      return writePause(state, nodeId, fromNodeId, `pre-guardrail: ${preReason}`);
    }
  }
  const piped = await runAgentPipeline(node, state, fromNodeId);
  if ("redirected" in piped) {
    await nodeEnd(null);
    return;
  }
  let result = piped;
  if (guardrails.post?.length) {
    const check = () => runGuardrails(guardrails.post, { context, nodeId, output: result.output, choice: result.choice });
    let reason = check();
    if (reason) {
      await emitHook("GuardrailFail", { nodeId, phase: "post", reason }, state);
      const retryNode = { ...node, instruction: `${node.instruction ?? ""}

GUARDRAIL FEEDBACK: ${reason}
Fix the issue and try again.` };
      try {
        result = await invokeAgent(retryNode, state);
      } catch {
        return writePause(state, nodeId, fromNodeId, `post-guardrail: ${reason} (retry failed)`);
      }
      reason = check();
      if (reason) {
        await emitHook("GuardrailFail", { nodeId, phase: "post", reason }, state);
        return writePause(state, nodeId, fromNodeId, `post-guardrail: ${reason} (after retry)`);
      }
    }
  }
  const nextNodeId = node.options?.[result.choice];
  if (!nextNodeId)
    return errorFallback(state, nodeId, node, `choice "${result.choice}" not declared`);
  context[nodeId] = result.output;
  await saveContext(state);
  await nodeEnd(nextNodeId);
  return executeNode(nextNodeId, nodeId, state);
}
function buildNodeExecuteCtx(node, fromNodeId, state) {
  return {
    node,
    fromNodeId,
    context: state.context,
    runId: state.runId,
    runDir: state.runDir,
    storage: state.storage,
    slice: (keys) => sliceContext(state.context, keys),
    render: (instruction, keys) => renderUserPrompt(sliceContext(state.context, keys), instruction),
    saveContext: () => saveContext(state),
    executeNode: (id, from) => executeNode(id, from, state),
    invokeAgent: (n, pre) => invokeAgent(n, state, pre),
    runAgent: (n) => runAgentPipeline(n, state, fromNodeId),
    emitHook: (event, payload) => emitHook(event, payload, state),
    writePause: (reason) => writePause(state, node.id, fromNodeId, reason),
    errorFallback: (error) => errorFallback(state, node.id, node, error),
    resolveFallback: () => resolveFallback(node, state.graph),
    log: (line) => state.storage.appendLog(state.runDir, line)
  };
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
async function buildRunState(runId, runDir, workflow, context, iterationCounts, overrides, storage) {
  const [hooks, nodeTypes] = await Promise.all([loadHooks(runDir), loadNodeTypes(runDir)]);
  return {
    runId,
    runDir,
    context,
    joinMap: new Map,
    iterationCounts,
    graph: workflow.graph,
    registry: workflow.registry,
    guardrails: workflow.guardrails ?? {},
    hooks,
    nodeTypes,
    storage,
    overrides
  };
}
async function run({ workflow, initialContext = {}, overrides = {} }) {
  const storage = await loadStorage();
  const runId = `${workflow.id}-${Date.now()}`;
  const runDir = await storage.createRun(runId);
  const state = await buildRunState(runId, runDir, workflow, { ...initialContext }, new Map, overrides, storage);
  abortIfHook(await emitHook("RunStart", { workflow, initialContext }, state));
  await executeNode(workflow.graph.start, null, state);
}
async function resume({ workflow, runId, choice, overrides = {} }) {
  const storage = await loadStorage();
  const runDir = storage.runDir(runId);
  if (!await storage.pauseExists(runDir))
    throw new Error(`No paused state for run: ${runId}`);
  const paused = await storage.loadPause(runDir);
  const fromNode = workflow.graph.nodes.find((n) => n.id === paused.nodeId);
  if (!fromNode?.options?.[choice])
    throw new Error(`Choice "${choice}" not valid for "${paused.nodeId}". Options: ${Object.keys(fromNode?.options ?? {})}`);
  const iterationCounts = new Map(Object.entries(paused.iterationCounts ?? {}));
  const state = await buildRunState(runId, runDir, workflow, paused.context, iterationCounts, overrides, storage);
  abortIfHook(await emitHook("Resumed", { nodeId: paused.nodeId, choice }, state));
  await executeNode(fromNode.options[choice], paused.nodeId, state);
}

// ../../../../private/tmp/supertinker-entry-XXXX.ts
var EMBEDDED = { "providers/claude.ts": `import { spawn, ChildProcess } from "child_process"
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "fs"
import { randomUUID } from "crypto"
import type { DisplayEvent, TranscriptMapper } from "../display-protocol.js"

interface ProviderContext {
  userPrompt:   string
  systemPrompt: string
  options:      string[]
  cwd:          string
  model?:       string
  logFile:      string
  onChunk?:     (chunk: string) => void
  signal?:      AbortSignal
}

interface AgentResult {
  output: string
  choice: string
  transcriptPath?: string
  metadata?: Record<string, unknown>
}

// \u2500\u2500\u2500 Session sidecar \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// When the same node invokes the Claude provider more than once (typical for
// \`persistent\` nodes driven by an event loop), we want Claude to keep its
// conversation history instead of starting fresh each turn. We persist the
// first turn's session_id in a sidecar file next to the node's log, and
// switch to \`--resume <id>\` on every subsequent turn.

function sessionPathFor(logFile: string): string {
  return logFile.replace(/\\.log$/, ".session")
}
function readExistingSession(logFile: string): string | null {
  const p = sessionPathFor(logFile)
  if (!existsSync(p)) return null
  const id = readFileSync(p, "utf8").trim()
  return id.length > 0 ? id : null
}
function writeSession(logFile: string, sessionId: string): void {
  writeFileSync(sessionPathFor(logFile), sessionId)
}

// \u2500\u2500\u2500 Child-process lifecycle \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Track every live Claude subprocess so we can guarantee it's dead when the
// orchestrator exits. Without this, \`cli.ts\` calls \`process.exit(0)\` after a
// --quiet run completes, which abandons any still-running \`claude\` child to
// init \u2014 it keeps burning tokens until it finishes on its own.
//
// On abort (AbortSignal or parent exit) we SIGTERM first, then SIGKILL after
// a short grace period. \`spawn\` is called without \`detached:true\`/\`unref()\`
// so the child stays in our process group and \`process.on("exit")\` can reach
// it synchronously.

const liveChildren = new Set<ChildProcess>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const killAll = () => {
    for (const p of liveChildren) { try { p.kill("SIGKILL") } catch {} }
  }
  // 'exit' is the only place we're guaranteed synchronous cleanup before
  // Node tears down. Signals arrive before exit, so handle them too \u2014 we
  // re-raise after cleanup so the default termination behavior still runs.
  process.on("exit", killAll)
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
    process.on(sig, () => { killAll(); process.exit(128) })
  }
}

function trackChild(proc: ChildProcess): void {
  installExitHook()
  liveChildren.add(proc)
  proc.once("close", () => liveChildren.delete(proc))
}

function killWithEscalation(proc: ChildProcess): void {
  try { proc.kill("SIGTERM") } catch {}
  // If SIGTERM is ignored, escalate after 2s. Clear timer if the child exits
  // on its own so we don't leak a timer handle.
  const esc = setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, 2000)
  proc.once("close", () => clearTimeout(esc))
}

// \u2500\u2500\u2500 Blocking (non-streaming) execution \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

function runBlocking(command: string, args: string[], cwd: string, logFile: string, signal?: AbortSignal): Promise<string> {
  return new Promise((res, rej) => {
    const proc = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    trackChild(proc)
    let out = "", err = ""
    const onAbort = () => killWithEscalation(proc)
    signal?.addEventListener("abort", onAbort, { once: true })
    proc.stdout!.on("data", (chunk: Buffer) => {
      const txt = chunk.toString(); out += txt
      appendFileSync(logFile, txt)
    })
    proc.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString() })
    proc.on("close", code => {
      signal?.removeEventListener("abort", onAbort)
      if (signal?.aborted) return rej(new Error(\`Aborted: \${(signal as any).reason?.message ?? "signal"}\`))
      code === 0 ? res(out) : rej(new Error(\`exit \${code}: \${err.slice(0, 300)}\`))
    })
    proc.stdin!.end()
  })
}

// \u2500\u2500\u2500 Streaming (stream-json) execution \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
// Parses NDJSON events, forwards text_delta to ctx.onChunk, captures the final
// "result" event. Also captures session_id for the sidecar.

interface StreamedResult {
  output:   string
  sessionId?: string
}

function runStreaming(
  command: string, args: string[], cwd: string, logFile: string,
  onChunk: (chunk: string) => void, signal?: AbortSignal,
): Promise<StreamedResult> {
  return new Promise((res, rej) => {
    const proc: ChildProcess = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] })
    trackChild(proc)

    let buf = "", err = ""
    let accumulated = ""
    let finalResult: string | undefined
    let sessionId:   string | undefined

    const onAbort = () => killWithEscalation(proc)
    signal?.addEventListener("abort", onAbort, { once: true })

    const handleLine = (line: string) => {
      if (!line.trim()) return
      appendFileSync(logFile, line + "\\n")
      let evt: any
      try { evt = JSON.parse(line) } catch { return }

      // Top-level session_id (on init and result events)
      if (typeof evt.session_id === "string") sessionId = evt.session_id

      // Anthropic-style stream_event wrapper with partial message deltas
      if (evt.type === "stream_event" && evt.event?.type === "content_block_delta") {
        const delta = evt.event.delta
        if (delta?.type === "text_delta" && typeof delta.text === "string") {
          accumulated += delta.text
          try { onChunk(delta.text) } catch {}
          return
        }
      }

      // Assistant message blocks sometimes carry the final text
      if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        for (const block of evt.message.content) {
          if (block.type === "text" && typeof block.text === "string" && !accumulated.endsWith(block.text)) {
            // Don't double-count if streamed deltas already covered this text.
            // (The CLI may emit both deltas and the full assistant message.)
          }
        }
      }

      // Terminal result event \u2014 authoritative output
      if (evt.type === "result") {
        if (typeof evt.result === "string") finalResult = evt.result
      }
    }

    proc.stdout!.on("data", (chunk: Buffer) => {
      buf += chunk.toString()
      const lines = buf.split(/\\r?\\n/)
      buf = lines.pop() ?? ""
      for (const line of lines) handleLine(line)
    })
    proc.stderr!.on("data", (chunk: Buffer) => { err += chunk.toString() })
    proc.on("close", code => {
      signal?.removeEventListener("abort", onAbort)
      if (buf.trim()) handleLine(buf)
      if (signal?.aborted) return rej(new Error(\`Aborted: \${(signal as any).reason?.message ?? "signal"}\`))
      if (code !== 0) return rej(new Error(\`exit \${code}: \${err.slice(0, 400)}\`))
      res({ output: finalResult ?? accumulated, sessionId })
    })
    proc.stdin?.end()
  })
}

// \u2500\u2500\u2500 Public entrypoint \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const existingSession = readExistingSession(ctx.logFile)
  const sessionId       = existingSession ?? randomUUID()
  const streaming       = typeof ctx.onChunk === "function"

  // Dashboard meta sidecar
  const claudeProjects = \`\${process.env.HOME}/.claude/projects\`
  const metaPath       = ctx.logFile.replace(/\\.log$/, ".meta.json")
  writeFileSync(metaPath, JSON.stringify({
    transcriptFile: \`\${sessionId}.jsonl\`, sessionId, claudeProjects, provider: "claude",
  }))

  // Argument assembly. Streaming mode drops --json-schema because stream-json
  // and schema validation don't compose; free-form output is fine for any
  // caller that opts into streaming (typically \`persistent\` nodes).
  const baseArgs: string[] = [
    "-p", ctx.userPrompt,
    "--system-prompt", ctx.systemPrompt,
    "--permission-mode", "auto",
    ...(existingSession ? ["--resume", existingSession] : ["--session-id", sessionId]),
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  let result: AgentResult
  if (streaming) {
    const args = [...baseArgs, "--output-format", "stream-json", "--verbose", "--include-partial-messages"]
    const streamed = await runStreaming("claude", args, ctx.cwd, ctx.logFile, ctx.onChunk!, ctx.signal)
    result = {
      output:   streamed.output,
      choice:   ctx.options[0] ?? "",
      metadata: { sessionId: streamed.sessionId ?? sessionId, streaming: true },
    }
    if (streamed.sessionId) writeSession(ctx.logFile, streamed.sessionId)
    else if (!existingSession) writeSession(ctx.logFile, sessionId)
  } else {
    // An empty options array would make the schema's choice.enum empty, which
    // the Claude CLI silently treats as "no schema" \u2014 the agent then returns
    // prose in \`result\` and no \`structured_output\`. For choice-less callers
    // (e.g. persistent nodes that strip options) skip the schema entirely and
    // take the raw result as free-form output.
    const hasOptions = ctx.options.length > 0
    const args = [...baseArgs, "--output-format", "json"]
    if (hasOptions) {
      const schema = JSON.stringify({
        type: "object",
        required: ["output", "choice"],
        properties: {
          output: { type: "string" },
          choice: { type: "string", enum: ctx.options },
        },
      })
      args.push("--json-schema", schema)
    }
    const raw = await runBlocking("claude", args, ctx.cwd, ctx.logFile, ctx.signal)
    const parsed = JSON.parse(raw.trim())
    if (hasOptions) {
      if (parsed.output !== undefined && parsed.choice !== undefined) result = parsed
      else if (parsed.structured_output?.output !== undefined && parsed.structured_output?.choice !== undefined) result = parsed.structured_output
      else if (parsed.result) result = JSON.parse(parsed.result)
      else throw new Error(\`Unexpected Claude output shape: \${raw.slice(0, 200)}\`)
    } else {
      // Non-empty marker so PostAgent hooks (e.g. retry) don't misread a
      // free-form call as a failed sentinel. Persistent-style callers
      // ignore \`choice\` downstream.
      result = { output: parsed.result ?? "", choice: "ok" }
    }
    result.metadata = { sessionId: parsed.session_id ?? sessionId, streaming: false }
    // Persist session for future turns
    if (!existingSession) writeSession(ctx.logFile, parsed.session_id ?? sessionId)
  }

  result.transcriptPath = \`\${sessionId}.jsonl\`
  return result
}

export const mapTranscript: TranscriptMapper = (line: string) => {
  let parsed: any
  try { parsed = JSON.parse(line) } catch { return null }

  const ts = parsed.timestamp ? new Date(parsed.timestamp).getTime() : Date.now()

  if (parsed.type === "queue-operation" || parsed.type === "attachment" || parsed.type === "system") return null

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
var BUILD_STAMP = "2026-04-17T15:19:21.651Z";
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
    const runner = (() => {
      try {
        __require("child_process").execSync("which bun", { stdio: "ignore" });
        return "bun";
      } catch {
        return "tsx";
      }
    })();
    try {
      execSync(runner + " " + cliPath + " " + escaped, { stdio: "inherit", cwd: process.cwd() });
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
