#!/usr/bin/env tsx
/**
 * cli.ts — CLI entrypoint for supertinker
 *
 * Usage:
 *   tsx cli.ts run --prompt "Build a REST API"
 *   tsx cli.ts run --workflow meta --prompt "Build a REST API"
 *   tsx cli.ts resume --run <runId> --choice <label> --workflow <name|path>
 *   tsx cli.ts status --run <runId>
 *   tsx cli.ts list
 */

import { existsSync, mkdirSync, readFileSync }  from "fs"
import { spawnSync }                             from "child_process"
import { join, resolve }                         from "path"
import { run, resume, buildCatalog, loadStorage, loadHooks } from "./supertinker.js"
import type { Context, ProviderOverrides }                   from "./supertinker.js"

// ─── TMUX AUTO-LAUNCH

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
    const storage = await loadStorage()
    const runDir = join("/tmp/orchestrator", runId)
    if (!existsSync(runDir)) { console.error(`Run directory not found: ${runDir}`); process.exit(1) }

    const hasPause = await storage.pauseExists(runDir)
    let hasContext = false
    try { await storage.loadContext(runDir); hasContext = true } catch {}

    console.log(`\n  Run: ${runId}`)
    console.log(`  Dir: ${runDir}`)
    console.log(`  Status: ${hasPause ? "PAUSED" : "completed"}\n`)

    if (hasPause) {
      const paused = await storage.loadPause(runDir)
      console.log(`  Paused at: ${paused.nodeId}`)
      if (paused.reason) console.log(`  Reason:    ${paused.reason}`)
      if (paused.iterationCounts) {
        const counts = Object.entries(paused.iterationCounts).filter(([, v]) => v > 0)
        if (counts.length > 0) console.log(`  Iterations: ${counts.map(([k, v]) => `${k}=${v}`).join(", ")}`)
      }
      console.log()
    }

    if (hasContext) {
      const ctx = await storage.loadContext(runDir)
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
    const storage = await loadStorage()
    console.log(await buildCatalog(storage))
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
  tsx cli.ts run --prompt "Build a REST API"
  tsx cli.ts run --workflow meta --prompt "Build a REST API"
  tsx cli.ts status --run meta-1234567890
  tsx cli.ts list`)
}

// ─── ENTRYPOINT

const cmd = process.argv[2]
if (!cmd || cmd === "list" || cmd === "status" || cmd === "help") cli().catch(err => { console.error(err); process.exit(1) })
else if (ensureTmux()) cli().catch(err => { console.error(err); process.exit(1) })
