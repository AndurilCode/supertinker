/**
 * chat — interactive REPL for persistent-agent workflows.
 *
 *   supertinker chat --workflow director            # auto-starts a fresh run
 *   supertinker chat --workflow director --run <id> # resumes an existing one
 *
 * Flow per turn:
 *   1. Read a line from stdin (`> ` prompt).
 *   2. Inject it into the paused run's state.context[<contextKey>].
 *   3. `supertinker resume --quiet` the run.
 *   4. Read state.context[<replyKey>] and print it.
 *   5. Loop.
 *
 * Commands inside the REPL:
 *   /exit, /quit       leave (the run stays paused, resume later)
 *   /run               show the runId (copy for `chat --run <id>` later)
 *   /raw               dump the full context.json
 *   /tail              tail -n 20 the orchestrator.log
 */

import { createInterface }                              from "readline"
import { existsSync, readFileSync, writeFileSync,
         statSync, readdirSync }                        from "fs"
import { join }                                         from "path"
import { spawn }                                        from "child_process"
import type { CommandPlugin }                           from "../../../cli.js"

const RUN_ROOT = "/tmp/orchestrator"

function supertinkerBin(): { cmd: string; args: string[] } {
  const self = process.argv[1] ?? "/Users/gpavanello/Repositories/supertinker/cli.ts"
  return { cmd: process.execPath, args: [self] }
}

function runChild(subArgs: string[]): Promise<number> {
  const { cmd, args } = supertinkerBin()
  return new Promise((resolve) => {
    const p = spawn(cmd, [...args, ...subArgs], { stdio: ["ignore", "ignore", "inherit"], env: process.env })
    p.on("exit", (code) => resolve(code ?? 0))
    p.on("error", () => resolve(1))
  })
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
  // Fire a detached, env-inheriting run — it'll auto-pause at the first
  // persistent-style node, which is our REPL entry point.
  spawn(
    supertinkerBin().cmd,
    [...supertinkerBin().args, "run", "--workflow", workflow, "--quiet"],
    { stdio: "ignore", env: { ...process.env, TMUX: "1" }, detached: true },
  ).unref()

  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const entries = readdirSync(RUN_ROOT)
        .filter(n => n.startsWith(`${workflow}-`))
        .map(n => ({ n, m: statSync(join(RUN_ROOT, n)).mtimeMs }))
        .filter(e => e.m >= sinceMs)
        .sort((a, b) => b.m - a.m)
      if (entries.length > 0 && existsSync(join(RUN_ROOT, entries[0].n, "state.json"))) {
        return entries[0].n
      }
    } catch {}
    await new Promise(r => setTimeout(r, 300))
  }
  return null
}

function readState(runDir: string): any {
  return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
}
function writeState(runDir: string, state: any): void {
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2))
}

export const command: CommandPlugin = {
  name: "chat",
  description: "interactive REPL for persistent-agent workflows",
  usage: "chat --workflow <name> [--run <runId>] [--choice <label>=event] [--context-key <k>=event] [--reply-key <k>]",
  async handler(_args, get) {
    const workflow   = get("--workflow")
    let   runId      = get("--run")
    const choice     = get("--choice")      ?? "event"
    const contextKey = get("--context-key") ?? "event"
    // reply-key defaults to the workflow id (director → context.director)
    const replyKey   = get("--reply-key")   ?? workflow

    if (!workflow) {
      console.error("Usage: supertinker chat --workflow <name> [--run <id>]")
      process.exit(1)
    }

    // ── Start or attach ────────────────────────────────────────────────
    if (!runId) {
      process.stdout.write(`chat: starting a fresh ${workflow} run...\n`)
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

    // Initial greeting
    const initial = readState(runDir)?.context?.[replyKey]
    process.stdout.write(`\nchat: connected to ${runId}  (type /exit to quit, /run for id, /raw for context)\n`)
    if (initial) process.stdout.write(`\n${initial}\n`)

    // ── REPL ──────────────────────────────────────────────────────────
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl.setPrompt("\n> ")
    rl.prompt()

    let thinking = false

    const printReply = (): void => {
      try {
        const st = readState(runDir)
        const reply = st?.context?.[replyKey]
        if (reply) process.stdout.write(`\n${reply}\n`)
        else process.stdout.write(`\n(no reply captured under context.${replyKey})\n`)
      } catch (err) {
        process.stdout.write(`\n(failed to read state: ${err})\n`)
      }
    }

    rl.on("line", async (raw) => {
      if (thinking) return
      const line = raw.trim()
      if (!line) { rl.prompt(); return }

      // Slash commands
      if (line === "/exit" || line === "/quit") {
        process.stdout.write(`\nchat: run is paused at ${runId}. resume later with:\n  supertinker chat --workflow ${workflow} --run ${runId}\n`)
        rl.close()
        return
      }
      if (line === "/run") { process.stdout.write(`runId: ${runId}\n`); rl.prompt(); return }
      if (line === "/raw") {
        try { process.stdout.write(readFileSync(join(runDir, "context.json"), "utf8") + "\n") } catch {}
        rl.prompt(); return
      }
      if (line === "/tail") {
        try {
          const lines = readFileSync(join(runDir, "orchestrator.log"), "utf8").trim().split("\n")
          process.stdout.write(lines.slice(-20).join("\n") + "\n")
        } catch {}
        rl.prompt(); return
      }

      // Inject + resume
      thinking = true
      try {
        const state = readState(runDir)
        state.context[contextKey] = line
        writeState(runDir, state)

        process.stdout.write("…thinking")
        const pulse = setInterval(() => process.stdout.write("."), 1000)
        const code = await runChild(["resume", "--run", runId!, "--choice", choice, "--workflow", workflow, "--quiet"])
        clearInterval(pulse)
        process.stdout.write("\r           \r")

        if (code !== 0) {
          process.stdout.write(`(resume exited ${code})\n`)
        } else {
          printReply()
        }
      } finally {
        thinking = false
        rl.prompt()
      }
    })

    rl.on("close", () => process.exit(0))
  },
}
