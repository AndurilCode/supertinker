/**
 * chat — interactive REPL for persistent-agent workflows.
 *
 * The rendering and turn-loop live in chat-ui.tsx (Ink/React). This file
 * handles CLI parsing, discovers or spawns a paused run, then mounts the
 * Ink app.
 *
 *   supertinker chat --workflow director            # auto-start fresh run
 *   supertinker chat --workflow director --run <id> # attach to existing
 *
 * Flags: --choice (default: event), --context-key (default: event),
 *        --reply-key (default: <workflow id>).
 */

import { existsSync, readFileSync, statSync, readdirSync }  from "fs"
import { join, dirname }                                    from "path"
import { spawn }                                            from "child_process"
import { fileURLToPath }                                    from "url"
import type { CommandPlugin }                               from "../../../cli.js"

const RUN_ROOT = "/tmp/orchestrator"

function supertinkerBin(): { cmd: string; args: string[] } {
  const self = process.argv[1] ?? "/Users/gpavanello/Repositories/supertinker/cli.ts"
  return { cmd: process.execPath, args: [self] }
}

async function waitForPause(runDir: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(join(runDir, "state.json"))) return true
    await new Promise(r => setTimeout(r, 300))
  }
  return false
}

async function startFreshRun(workflow: string, timeoutMs: number): Promise<string | null> {
  const sinceMs = Date.now()
  spawn(
    supertinkerBin().cmd,
    [...supertinkerBin().args, "run", "--workflow", workflow, "--quiet"],
    { stdio: "ignore", env: { ...process.env, TMUX: "1" }, detached: true },
  ).unref()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const matches = readdirSync(RUN_ROOT)
        .filter(n => n.startsWith(`${workflow}-`))
        .map(n => ({ n, m: statSync(join(RUN_ROOT, n)).mtimeMs }))
        .filter(e => e.m >= sinceMs)
        .sort((a, b) => b.m - a.m)
      if (matches.length > 0 && existsSync(join(RUN_ROOT, matches[0].n, "state.json"))) {
        return matches[0].n
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

export const command: CommandPlugin = {
  name: "chat",
  description: "interactive REPL (Ink UI) for persistent-agent workflows",
  usage: "chat --workflow <name> [--run <runId>] [--choice <label>=event] [--context-key <k>=event] [--reply-key <k>]",
  async handler(_args, get) {
    const workflow   = get("--workflow")
    let   runId      = get("--run")
    const choice     = get("--choice")      ?? "event"
    const contextKey = get("--context-key") ?? "event"
    const replyKey   = get("--reply-key")   ?? workflow

    if (!workflow) {
      console.error("Usage: supertinker chat --workflow <name> [--run <id>]")
      process.exit(1)
    }

    if (!runId) {
      process.stdout.write(`starting a fresh ${workflow} run...\n`)
      const id = await startFreshRun(workflow, 60_000)
      if (!id) {
        console.error("chat: run did not pause within 60s — check hooks / workflow definition")
        process.exit(1)
      }
      runId = id
    }

    const runDir = join(RUN_ROOT, runId)
    if (!existsSync(join(runDir, "state.json"))) {
      if (!await waitForPause(runDir, 30_000)) {
        console.error(`chat: ${runId} is not paused (no state.json) — nothing to resume`)
        process.exit(1)
      }
    }

    let initial: string | undefined
    try {
      const state = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
      initial = state?.context?.[replyKey!]
    } catch {}

    // chat-ui.tsx ships alongside this file. Resolve relative to our own module
    // path so the installed copy (.supertinker/commands/chat-ui.tsx) is found.
    const here = dirname(fileURLToPath(import.meta.url))
    const uiPath = join(here, "chat-ui.tsx")
    const ui = await import(uiPath)
    ui.mountChat({ runId: runId!, workflow, choice, contextKey, replyKey: replyKey!, initial })
  },
}
