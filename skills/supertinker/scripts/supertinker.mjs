#!/usr/bin/env bun
// @bun

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
import { createRequire } from "module";
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
    const esmRequire = createRequire(import.meta.url);
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
import { appendFileSync } from "fs"
import { randomUUID } from "crypto"

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
    const proc = spawn(command, args, { cwd, env: process.env })
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
    ? \`\${process.env.HOME}/.claude/projects/\${parsed.session_id}.jsonl\`
    : undefined

  return result
}
`, "providers/copilot.ts": `import { spawn } from "child_process"
import { appendFileSync } from "fs"

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
    const proc = spawn(command, args, { cwd, env: process.env })
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

function extractContent(raw: string): string {
  const lines = raw.trim().split("\\n")
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i])
      if (evt.type === "assistant.message" && evt.data?.content) return evt.data.content
    } catch { /* not JSON */ }
  }
  return raw
}

function extractSessionId(raw: string): string | null {
  for (const line of raw.trim().split("\\n")) {
    try {
      const evt = JSON.parse(line)
      if (evt.type === "session.start" && evt.data?.sessionId) return evt.data.sessionId
    } catch { /* not JSON */ }
  }
  return null
}

function parseSentinel(raw: string, options: string[]): AgentResult | null {
  const m = raw.match(/---CHOICE---\\s*\\n\\s*(\\S+)\\s*\\n\\s*---END---/)
  if (!m) return null
  const choice = m[1].trim()
  if (!options.includes(choice)) return null
  const output = raw.slice(0, raw.indexOf("---CHOICE---")).trim()
  return { output, choice }
}

export async function invoke(ctx: ProviderContext, retry = false): Promise<AgentResult> {
  const retryHint = retry
    ? "\\n\\nWARNING: Your previous response was missing the ---CHOICE--- sentinel block. Include it now."
    : ""

  const fullPrompt = \`\${ctx.systemPrompt}\\n\\n\${ctx.userPrompt}\${retryHint}\`
  const args = [
    "-p", fullPrompt,
    "--autopilot",
    "--yolo",
    "--output-format", "json",
    ...(ctx.model ? ["--model", ctx.model] : []),
  ]

  const raw = await run("copilot", args, ctx.cwd, ctx.logFile)
  const content = extractContent(raw)
  const result = parseSentinel(content, ctx.options)

  if (!result && !retry) return invoke(ctx, true)
  if (!result) throw new Error(\`No valid sentinel after retry. Output: \${content.slice(0, 300)}\`)

  const sessionId = extractSessionId(raw)
  if (sessionId) {
    result.transcriptPath = \`\${process.env.HOME}/.copilot/session-state/\${sessionId}/events.jsonl\`
  }

  return result
}
`, "hooks/logger.ts": `import { appendFileSync } from "fs"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../supertinker.js"

function fmt(level: string, nodeId: string, msg: string): string {
  const ts = new Date().toISOString().slice(11, 19)
  return \`[\${ts}] \${level.padEnd(7)} \${nodeId.padEnd(22)} \${msg}\`
}

function write(event: HookEvent, level: string, nodeId: string, msg: string): void {
  const line = fmt(level, nodeId, msg)
  appendFileSync(join(event.runDir, "orchestrator.log"), line + "\\n")
  process.stdout.write(line + "\\n")
}

export const hook: Hook = {
  name: "logger",
  description: "Built-in structured logging for all orchestrator events",
  events: [
    "RunStart", "RunEnd", "PreAgent", "PreProvider", "PostAgent", "Paused", "Resumed",
    "ForkStart", "ForkJoin", "GuardrailFail", "SubworkflowStart", "SubworkflowEnd", "Error",
  ],
  parallel: true,
  priority: 0,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    switch (event.event) {
      case "RunStart": {
        const e = event as Extract<HookEvent, { event: "RunStart" }>
        write(event, "RUN", e.runId, e.workflow.description)
        write(event, "RUN", e.runId, \`graph: \${e.workflow.graph.id}  nodes: \${e.workflow.graph.nodes.length}  dir: \${e.runDir}\`)
        break
      }
      case "RunEnd": {
        const e = event as Extract<HookEvent, { event: "RunEnd" }>
        if (e.terminal === "done") write(event, "DONE", "graph", "\u2713 completed")
        else write(event, "FAILED", "graph", "\u2717 failed")
        break
      }
      case "PreAgent": {
        const e = event as Extract<HookEvent, { event: "PreAgent" }>
        write(event, "START", e.nodeId, \`agent: \${e.agent}\`)
        break
      }
      case "PreProvider": {
        const e = event as Extract<HookEvent, { event: "PreProvider" }>
        write(event, "INVOKE", e.nodeId, \`provider: \${e.provider}\${e.model ? \` model: \${e.model}\` : ""}\`)
        break
      }
      case "PostAgent": {
        const e = event as Extract<HookEvent, { event: "PostAgent" }>
        write(event, "CHOICE", e.nodeId, \`\u2192 \${e.result.choice}\`)
        break
      }
      case "Paused": {
        const e = event as Extract<HookEvent, { event: "Paused" }>
        if (e.reason) write(event, "GUARD", e.nodeId, e.reason)
        write(event, "PAUSED", e.nodeId, \`state \u2192 \${e.stateFile}\`)
        write(event, "PAUSED", e.nodeId, \`resume: supertinker resume --run \${e.runId} --choice <label> --workflow <path>\`)
        break
      }
      case "Resumed": {
        const e = event as Extract<HookEvent, { event: "Resumed" }>
        write(event, "RESUME", e.runId, \`node: \${e.nodeId}  choice: \${e.choice}\`)
        break
      }
      case "ForkStart": {
        const e = event as Extract<HookEvent, { event: "ForkStart" }>
        write(event, "FORK", e.nodeId, \`\u2192 [\${e.targets.join(", ")}]\`)
        break
      }
      case "ForkJoin": {
        const e = event as Extract<HookEvent, { event: "ForkJoin" }>
        write(event, "JOIN", e.nodeId, \`\${e.joinedFrom.length} branches joined\`)
        break
      }
      case "GuardrailFail": {
        const e = event as Extract<HookEvent, { event: "GuardrailFail" }>
        write(event, "GUARD", e.nodeId, \`\${e.phase}-guardrail: \${e.reason}\`)
        break
      }
      case "SubworkflowStart": {
        const e = event as Extract<HookEvent, { event: "SubworkflowStart" }>
        write(event, "SUBWORK", e.nodeId, \`executing "\${e.innerWorkflow.id}" (\${e.innerWorkflow.graph.nodes.length} nodes)\`)
        break
      }
      case "SubworkflowEnd": {
        const e = event as Extract<HookEvent, { event: "SubworkflowEnd" }>
        write(event, "SUBWORK", e.nodeId, "completed")
        break
      }
      case "Error": {
        const e = event as Extract<HookEvent, { event: "Error" }>
        write(event, "ERROR", e.nodeId, e.error)
        break
      }
    }

    return { action: "continue" }
  },
}
`, "hooks/tmux-panes.ts": `import { spawn } from "child_process"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../supertinker.js"

function tmuxRunning(): boolean { return !!process.env.TMUX }

function tmux(action: "new-window" | "kill-window", name: string, cmd?: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    const args = action === "new-window" ? [action, "-n", safe, cmd!] : [action, "-t", safe]
    spawn("tmux", args, { detached: true, stdio: "ignore" }).unref()
  } catch { /* not in tmux */ }
}

export const hook: Hook = {
  name: "tmux-panes",
  description: "Opens tmux panes for orchestrator log and per-agent log tailing",
  events: ["RunStart", "PreProvider", "PostAgent", "Error"],
  parallel: true,
  priority: 90,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    switch (event.event) {
      case "RunStart": {
        tmux("new-window", "orch-log", \`tail -f \${join(event.runDir, "orchestrator.log")}\`)
        break
      }
      case "PreProvider": {
        const e = event as Extract<HookEvent, { event: "PreProvider" }>
        tmux("new-window", \`node-\${e.nodeId}\`, \`tail -f \${e.logFile}\`)
        break
      }
      case "PostAgent": {
        const e = event as Extract<HookEvent, { event: "PostAgent" }>
        setTimeout(() => tmux("kill-window", \`node-\${e.nodeId}\`), 800)
        break
      }
      case "Error": {
        const e = event as Extract<HookEvent, { event: "Error" }>
        setTimeout(() => tmux("kill-window", \`node-\${e.nodeId}\`), 800)
        break
      }
    }
    return { action: "continue" }
  },
}
`, "hooks/validate-templates.ts": `import type { Hook, HookEvent, HookDirective } from "../supertinker.js"

export const hook: Hook = {
  name: "validate-templates",
  description: "Aborts run if workflow instructions reference undefined template variables",
  events: ["RunStart"],
  parallel: false,
  priority: 0,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    const e = event as Extract<HookEvent, { event: "RunStart" }>
    const { graph } = e.workflow
    const initialContext = e.initialContext

    const nodeIds = new Set(graph.nodes.map(n => n.id))
    const unresolved: Array<{ nodeId: string; variable: string }> = []

    for (const node of graph.nodes) {
      if (!node.instruction) continue
      for (const match of node.instruction.matchAll(/\\[(\\w[\\w-]*)\\]/g)) {
        const variable = match[1]
        if (!nodeIds.has(variable) && !(variable in initialContext))
          unresolved.push({ nodeId: node.id, variable })
      }
    }

    if (unresolved.length > 0) {
      const details = unresolved.map(({ nodeId, variable }) => \`  \u2022 [\${variable}] in node "\${nodeId}"\`).join("\\n")
      return {
        action: "abort",
        reason: \`Workflow "\${graph.id}" has unresolved template variables.\\nAdd them to initialContext:\\n\${details}\`,
      }
    }

    return { action: "continue" }
  },
}
`, "workflows/meta.workflow.ts": `import type { Workflow } from "../supertinker"

export const workflow: Workflow = {
  id: "meta-generate-and-run",
  description: "An architect agent designs a workflow, then the orchestrator executes it",

  registry: {
    architect: {
      command: "claude",
      model: "sonnet",
      systemPrompt: \`You are a workflow architect for the supertinker orchestrator.

Given a task, you design a Workflow that accomplishes it. Scale complexity to match the task:
- Simple task (one file, one concern) \u2192 1-2 agent nodes
- Medium task (multiple files, needs planning) \u2192 plan \u2192 implement \u2192 review loop
- Complex task (independent workstreams) \u2192 plan \u2192 fork parallel branches \u2192 join \u2192 review

YOUR OUTPUT MUST BE A SINGLE VALID JSON OBJECT. No markdown fences, no explanation, just raw JSON.

## Workflow schema

{
  "id": string,
  "description": string,
  "graph": {
    "id": string,
    "start": string,
    "fallback": string,        // must point to a "paused" node
    "labels": string[],
    "nodes": [ ...see node types below... ]
  },
  "registry": {
    "<agent_id>": {
      "command": "claude",
      "model": "sonnet",
      "systemPrompt": string   // tell the agent its role and expected output format
    }
  }
}

## Node types

STANDARD \u2014 runs an agent:
{
  "id": string,
  "agent": string,              // must match a registry key
  "instruction": string,        // what to do; reference context keys as [key]
  "slice": string[],            // optional \u2014 only pass these context keys (default: all)
  "options": { "label": "next_node_id" }
}

FORK \u2014 fans out to N parallel nodes (no agent):
{ "id": string, "type": "fork", "targets": ["node_a", "node_b"] }

JOIN \u2014 waits for all listed nodes to complete, then continues:
{
  "id": string, "type": "join", "waits_for": ["node_a", "node_b"],
  "agent": string,              // optional \u2014 runs after unblocking
  "instruction": string,
  "options": { "label": "next_node_id" }
}

TERMINALS:
{ "id": string, "type": "done" }
{ "id": string, "type": "paused" }

## Patterns

REVIEW LOOP \u2014 edges can point backward:
  review.options: { "approved": "done_node", "needs_work": "implement_node" }
  The implement node re-runs with accumulated context (review feedback is visible).

PARALLEL WORK \u2014 fork + join:
  fork \u2192 [branch_a, branch_b] \u2192 join (waits_for: [branch_a, branch_b])

CONTEXT THREADING:
  Each node's output is stored as context[node.id].
  Use "slice" to limit what an agent sees. Reference prior output via [node_id] in instructions.
  Example: "Review the code in [implement] against the plan in [plan]"

## Guardrails

Workflows can include guardrails \u2014 mechanical checks that run before/after each agent.

"guardrails": {
  "maxIterations": 3,
  "pre":  [ ...rules... ],       // run before each agent
  "post": [ ...rules... ]        // run after each agent, before following edge
}

Each rule is a JSON object with a JS expression that gets evaluated at runtime:

{ "check": "<JS expression>", "reason": "<message on failure>", "nodeId": "<optional \u2014 scope to one node>" }

Available variables in the expression: output (string), choice (string), nodeId (string), context (object), require (function \u2014 for filesystem checks like require('fs').existsSync(...)).

Examples:
  { "check": "output.trim().length > 0", "reason": "Empty output" }
  { "check": "output.length < 10000", "reason": "Output too long" }
  { "check": "!/(sk-|ghp_|AKIA)[A-Za-z0-9]{10,}/.test(output)", "reason": "Contains API key" }
  { "check": "require('fs').existsSync('README.md')", "reason": "README.md was not created", "nodeId": "write" }
  { "check": "require('fs').statSync('src/index.ts').size > 0", "reason": "src/index.ts is empty", "nodeId": "implement" }

On failure: post-guardrails retry the agent once with the reason injected, then pause. Pre-guardrails pause immediately.
Use maxIterations (default: 3) on any workflow with review loops to prevent infinite cycling.

## Agents are coding agents

Agents run as full coding agents (e.g. Claude Code CLI) with filesystem access. They can read files, write files, run commands, and modify the codebase directly. Design workflows accordingly:
- Agent system prompts should instruct agents to ACT on the codebase (read, write, modify files) \u2014 not to return file content as output
- Agent output (the "output" field) should be a brief status/summary of what was done, not the full content
- Guardrails that verify work products should check filesystem state, not output content
- Example guardrail checking a file was created: { "check": "require('fs').existsSync('README.md')", "reason": "README.md was not created" }

## Performance rules

EXPLORER/ANALYST agents are the #1 bottleneck. Constrain them:
- Always add to their systemPrompt: "Keep your output under 2000 words. Summarize findings, don't dump raw content."
- Use "slice" to limit what context they receive \u2014 don't pass the entire context to explorers
- If an explorer only needs to check specific files, say so in the instruction

IMPLEMENTER agents are the #2 bottleneck. Parallelize them:
- When 2+ files/modules can be built independently, ALWAYS use fork/join \u2014 never serialize independent work
- Each fork branch should handle one focused unit (one file, one module, one component)
- The join node should integrate/review, not re-implement

## Rules

1. Every agent referenced in nodes MUST exist in registry
2. Use "claude" as command, "sonnet" as model for all agents
3. Every graph needs exactly one "done" and one "paused" node minimum
4. Give each agent a clear systemPrompt defining its role and expected actions (not output format \u2014 agents act, not produce text)
5. Match workflow complexity to task complexity \u2014 don't over-engineer simple tasks
6. For multi-file tasks, ALWAYS prefer fork/join over serial agents \u2014 parallel branches are 3-4x faster
7. Output must be parseable by JSON.parse() \u2014 no trailing commas, no comments
8. Keep agent system prompts focused: role + what to do on the filesystem
9. REUSE FIRST: if [catalog] contains a workflow that fits the task, output it as-is or adapt it. Only design from scratch if nothing matches.
10. Always set maxIterations on workflows with review loops to prevent infinite cycling\`
    }
  },

  guardrails: {
    post: [
      // Architect output must be valid Workflow JSON
      ({ nodeId, output }) => {
        if (nodeId !== "design" || !output) return { pass: true }
        try {
          const w = JSON.parse(output)
          if (!w.graph?.start || !w.graph?.nodes || !w.registry) {
            return { pass: false, reason: "Workflow JSON missing required fields (graph.start, graph.nodes, registry)" }
          }
          return { pass: true }
        } catch {
          return { pass: false, reason: "Output is not valid JSON \u2014 must be a raw Workflow object, no markdown fences" }
        }
      }
    ],
    maxIterations: 3,
  },

  graph: {
    id: "meta-generate-and-run",
    start: "design",
    fallback: "human_review",
    labels: ["done"],

    nodes: [
      {
        id: "design",
        agent: "architect",
        instruction: "The working directory is [cwd]. Check it for any existing artifacts relevant to the task \u2014 don't redo work that's already done. Check the workflow library in [catalog]. If an existing workflow matches the task in [task], output it as-is or with modifications. Only design from scratch if nothing fits. Set cwd on agent nodes to [cwd] when the task targets an existing project. Output ONLY the raw Workflow JSON.",
        options: {
          done: "execute"
        }
      },
      {
        id: "execute",
        type: "subworkflow",
        source: "design",
        slice: ["task"],            // only pass task to inner workflow, not the raw design JSON
        options: {
          done: "complete"
        }
      },
      { id: "complete",     type: "done" },
      { id: "human_review", type: "paused" }
    ]
  }
}
` };
var BUILD_STAMP = "2026-04-15T15:33:27.364Z";
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
    console.log(await buildCatalog());
    return;
  }
  console.log(`supertinker \u2014 minimal agent orchestrator

Commands:
  run     [--workflow <name|path>] --prompt <text> [--provider <name>] [--model <name>]
  resume  --run <runId> --choice <label> --workflow <name|path> [--provider <name>] [--model <name>]
  list    show available workflows

Options:
  --provider   Override provider for all agents (e.g. copilot, claude)
  --model      Override model for all agents (e.g. opus, gpt-4o)

Examples:
  supertinker run --prompt "Build a REST API"
  supertinker run --prompt "Build a REST API" --provider copilot --model gpt-4o
  supertinker run --prompt "Build a REST API" --model opus
  supertinker list`);
}
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
