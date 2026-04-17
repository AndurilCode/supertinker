/**
 * subscribe — tail an event source and trigger workflow runs/resumes per event.
 *
 * Two modes:
 *
 *   resume mode — feed events into a running persistent agent:
 *     supertinker subscribe --source file:<path> \
 *                           --run <runId> --choice <label> \
 *                           --workflow <name> \
 *                           [--context-key <key>]
 *
 *   spawn mode — each event starts a fresh workflow run:
 *     supertinker subscribe --source file:<path> \
 *                           --workflow <name> \
 *                           [--prompt-template "prefix: {event}"]
 *
 * Only file: sources are supported right now; each newline in the file is one
 * event. The subscribe process polls file size every 500 ms and replays new
 * bytes as events. In resume mode, the event is merged into the run's paused
 * context (default key: "event") before `supertinker resume` is invoked.
 */

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync, writeFileSync } from "fs"
import { join }         from "path"
import { spawn }        from "child_process"
import type { CommandPlugin } from "../../../cli.js"

function supertinkerBin(): { cmd: string; args: string[] } {
  // Prefer the currently-running interpreter (bun / node) so this works in
  // installed CLI contexts and during local development alike.
  const self = process.argv[1] ?? "/Users/gpavanello/Repositories/supertinker/cli.ts"
  return { cmd: process.execPath, args: [self] }
}

function runChild(subArgs: string[]): Promise<number> {
  const { cmd, args } = supertinkerBin()
  return new Promise((resolve) => {
    const p = spawn(cmd, [...args, ...subArgs], { stdio: ["ignore", "inherit", "inherit"], env: process.env })
    // Use "exit" not "close" — inherited stdio fds stay open after the child
    // process exits, so "close" may never fire.
    p.on("exit", (code) => resolve(code ?? 0))
    p.on("error", (err) => { console.error(`subscribe: child error: ${err.message}`); resolve(1) })
  })
}

async function resumeRun(runId: string, choice: string, workflow: string): Promise<void> {
  const status = await runChild(["resume", "--run", runId, "--choice", choice, "--workflow", workflow, "--quiet"])
  if (status !== 0) console.error(`subscribe: resume exited ${status}`)
}

async function spawnRun(workflow: string, prompt: string): Promise<void> {
  const status = await runChild(["run", "--workflow", workflow, "--prompt", prompt, "--quiet"])
  if (status !== 0) console.error(`subscribe: run exited ${status}`)
}

function injectEventIntoPausedState(runId: string, contextKey: string, event: string): boolean {
  const runDir    = `/tmp/orchestrator/${runId}`
  const statePath = join(runDir, "state.json")
  if (!existsSync(statePath)) {
    console.error(`subscribe: no paused state for ${runId} (${statePath}) — resume mode requires an already-paused run`)
    return false
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"))
  state.context[contextKey] = event
  writeFileSync(statePath, JSON.stringify(state, null, 2))
  return true
}

export const command: CommandPlugin = {
  name: "subscribe",
  description: "tail an event source and resume or spawn workflow runs per event",
  usage:
    "subscribe --source file:<path> --workflow <name> " +
    "[--run <runId> --choice <label> [--context-key <k>]] " +
    "[--prompt-template <tmpl>]",
  async handler(args, get) {
    const source         = get("--source")
    const workflow       = get("--workflow")
    const runId          = get("--run")
    const choice         = get("--choice")
    const contextKey     = get("--context-key") ?? "event"
    const promptTemplate = get("--prompt-template") ?? "{event}"

    if (!source || !workflow) {
      console.error(
        "Usage: supertinker subscribe --source file:<path> --workflow <name> " +
        "[--run <id> --choice <label> --context-key <k>] [--prompt-template <tmpl>]",
      )
      process.exit(1)
    }
    if (!source.startsWith("file:")) {
      console.error(`subscribe: only file: sources are supported (got: ${source})`)
      process.exit(1)
    }

    const filePath = source.slice("file:".length)
    const mode     = runId && choice ? "resume" : "spawn"
    console.log(
      `subscribe: mode=${mode} source=${filePath} workflow=${workflow}` +
      (mode === "resume" ? ` run=${runId} choice=${choice} contextKey=${contextKey}` : ""),
    )

    let lastSize = existsSync(filePath) ? statSync(filePath).size : 0
    let running = false   // serialize event processing so resume/run calls don't overlap
    const queue: string[] = []

    const drain = async () => {
      if (running) return
      const evt = queue.shift()
      if (evt === undefined) return
      running = true
      try {
        console.log(`subscribe: event → ${JSON.stringify(evt).slice(0, 120)}`)
        if (mode === "resume") {
          if (injectEventIntoPausedState(runId!, contextKey, evt)) {
            await resumeRun(runId!, choice!, workflow)
          }
        } else {
          await spawnRun(workflow, promptTemplate.replace(/\{event\}/g, evt))
        }
      } finally {
        running = false
        setImmediate(drain)
      }
    }

    const tick = () => {
      if (existsSync(filePath)) {
        const sz = statSync(filePath).size
        if (sz > lastSize) {
          const fd  = openSync(filePath, "r")
          const buf = Buffer.alloc(sz - lastSize)
          readSync(fd, buf, 0, buf.length, lastSize)
          closeSync(fd)
          lastSize = sz
          for (const line of buf.toString("utf8").split(/\r?\n/)) {
            const e = line.trim()
            if (e) queue.push(e)
          }
          void drain()
        } else if (sz < lastSize) {
          lastSize = sz   // file truncated — reset pointer
        }
      }
    }
    setInterval(tick, 500)
    console.log(`subscribe: tailing ${filePath} (poll 500ms) — press Ctrl-C to stop`)
  },
}
