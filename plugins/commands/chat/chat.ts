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

// ─── ANSI helpers ──────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
  magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m",
  bgGray: "\x1b[100m",
}

// ─── Spinner ───────────────────────────────────────────────────────────────
// Braille-based; works in any modern terminal. Overwrites the line via \r.
function startSpinner(label: string): () => void {
  const frames = ["⠋","⠙","⠹","⠸","⠼","⠴","⠦","⠧","⠇","⠏"]
  let i = 0
  const render = () => process.stdout.write(`\r${C.cyan}${frames[i++ % frames.length]}${C.reset} ${C.dim}${label}${C.reset}`)
  render()
  const t = setInterval(render, 80)
  return () => {
    clearInterval(t)
    // Erase the spinner line completely.
    process.stdout.write(`\r\x1b[2K`)
  }
}

// ─── Minimal markdown → ANSI renderer ──────────────────────────────────────
// Covers the constructs models actually reach for: headings, bold, italic,
// inline code, fenced code blocks, bullet lists, numbered lists, blockquotes,
// links, horizontal rules. Everything else is passed through unchanged.
function renderMarkdown(md: string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let inFence = false
  let fenceLang = ""
  let codeBuf: string[] = []

  const flushFence = () => {
    if (codeBuf.length === 0) return
    const top = fenceLang ? `${C.gray}┌─ ${fenceLang} ${"─".repeat(Math.max(1, 40 - fenceLang.length))}${C.reset}` : `${C.gray}┌${"─".repeat(42)}${C.reset}`
    const bot = `${C.gray}└${"─".repeat(43)}${C.reset}`
    out.push(top)
    for (const l of codeBuf) out.push(`${C.gray}│${C.reset} ${C.green}${l}${C.reset}`)
    out.push(bot)
    codeBuf = []
    fenceLang = ""
  }

  const inline = (s: string): string => {
    // Inline code (run first so emphasis inside code isn't processed)
    s = s.replace(/`([^`]+)`/g, (_, code) => `${C.bgGray}${C.cyan} ${code} ${C.reset}`)
    // Bold **text** or __text__
    s = s.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`)
    s = s.replace(/__([^_]+)__/g, `${C.bold}$1${C.reset}`)
    // Italic *text* or _text_ (after bold so we don't re-match)
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, `$1${C.italic}$2${C.reset}`)
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g, `$1${C.italic}$2${C.reset}`)
    // Links [text](url) — show as underlined text + dim url
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.underline}${C.blue}$1${C.reset} ${C.dim}($2)${C.reset}`)
    return s
  }

  for (const raw of lines) {
    // Fenced code blocks
    const fence = raw.match(/^```(\w*)\s*$/)
    if (fence) {
      if (inFence) { flushFence(); inFence = false }
      else         { inFence = true; fenceLang = fence[1] ?? "" }
      continue
    }
    if (inFence) { codeBuf.push(raw); continue }

    // Horizontal rule
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { out.push(`${C.gray}${"─".repeat(44)}${C.reset}`); continue }

    // Headings
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length
      const text = inline(h[2])
      if (level === 1) out.push(`\n${C.bold}${C.underline}${text}${C.reset}\n`)
      else if (level === 2) out.push(`\n${C.bold}${C.yellow}${text}${C.reset}`)
      else out.push(`${C.bold}${text}${C.reset}`)
      continue
    }

    // Blockquote
    if (/^\s*>\s+/.test(raw)) { out.push(`${C.gray}│${C.reset} ${C.dim}${inline(raw.replace(/^\s*>\s+/, ""))}${C.reset}`); continue }

    // Bullet list
    const b = raw.match(/^(\s*)[-*+]\s+(.*)$/)
    if (b) { out.push(`${b[1]}${C.cyan}•${C.reset} ${inline(b[2])}`); continue }

    // Numbered list
    const n = raw.match(/^(\s*)(\d+\.)\s+(.*)$/)
    if (n) { out.push(`${n[1]}${C.cyan}${n[2]}${C.reset} ${inline(n[3])}`); continue }

    out.push(inline(raw))
  }
  if (inFence) flushFence()
  return out.join("\n")
}

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

// ─── Active runs footer ────────────────────────────────────────────────────
// Scans /tmp/orchestrator/ for runs that are still in play and formats a
// compact status block: runId, current node, and derived status. Skips
// terminal runs (done/failed) so the footer stays useful.

interface RunStatus {
  runId:       string
  currentNode: string
  status:      "paused" | "running" | "done" | "failed" | "unknown"
  mtimeMs:     number
  isCurrent:   boolean
}

function classifyRun(runDir: string, runId: string, currentRunId: string): RunStatus | null {
  try {
    const mtimeMs = statSync(runDir).mtimeMs
    // Paused runs carry a state.json — that's the authoritative "waiting here" marker
    if (existsSync(join(runDir, "state.json"))) {
      try {
        const s = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
        return { runId, currentNode: s.nodeId ?? "?", status: "paused", mtimeMs, isCurrent: runId === currentRunId }
      } catch {}
    }
    // Otherwise parse the log for the latest node-level event
    const logPath = join(runDir, "orchestrator.log")
    if (!existsSync(logPath)) return null
    const log = readFileSync(logPath, "utf8")
    if (/^\[[^\]]+\]\s+DONE\s+graph/m.test(log))   return { runId, currentNode: "done",   status: "done",   mtimeMs, isCurrent: runId === currentRunId }
    if (/^\[[^\]]+\]\s+FAILED\s+graph/m.test(log)) return { runId, currentNode: "failed", status: "failed", mtimeMs, isCurrent: runId === currentRunId }
    // Walk backwards: find the most recent START/RESUME line
    const lines = log.trim().split(/\r?\n/)
    let currentNode = "?"
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\]\s+(?:START|RESUME|INVOKE)\s+(\S+)/)
      if (m) { currentNode = m[1]; break }
    }
    return { runId, currentNode, status: "running", mtimeMs, isCurrent: runId === currentRunId }
  } catch { return null }
}

function formatFooter(currentRunId: string): string {
  let entries: RunStatus[] = []
  try {
    const names = readdirSync(RUN_ROOT)
    for (const n of names) {
      const dir = join(RUN_ROOT, n)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const s = classifyRun(dir, n, currentRunId)
      if (s) entries.push(s)
    }
  } catch { return "" }

  // Keep the current run + anything still running/paused. Sort: current
  // first, then by mtime desc. Cap at 8 rows so the footer never dominates.
  const active = entries.filter(e => e.isCurrent || e.status === "paused" || e.status === "running")
  active.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1
    if (!a.isCurrent && b.isCurrent) return 1
    return b.mtimeMs - a.mtimeMs
  })
  const shown = active.slice(0, 8)
  if (shown.length === 0) return ""

  const rows = shown.map(e => {
    const statusColor =
      e.status === "paused"  ? C.yellow :
      e.status === "running" ? C.green  :
      e.status === "failed"  ? C.red    :
      e.status === "done"    ? C.dim    : C.gray
    const marker = e.isCurrent ? `${C.cyan}●${C.reset}` : ` `
    const statusBadge = `${statusColor}${e.status.padEnd(7)}${C.reset}`
    return `  ${marker} ${statusBadge} ${C.cyan}${e.runId}${C.reset} ${C.dim}@${e.currentNode}${C.reset}`
  })

  const hiddenCount = active.length - shown.length
  const header = `${C.gray}─── runs (${active.length}) ${"─".repeat(30)}${C.reset}`
  const footer = hiddenCount > 0 ? `  ${C.dim}…and ${hiddenCount} more${C.reset}` : null
  return [header, ...rows, ...(footer ? [footer] : [])].join("\n")
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
    process.stdout.write(`\n${C.dim}chat: connected to ${C.reset}${C.cyan}${runId}${C.reset}${C.dim}  (type /help for commands)${C.reset}\n`)
    if (initial) process.stdout.write(`\n${renderMarkdown(initial)}\n`)

    const printFooter = (): void => {
      const f = formatFooter(runId!)
      if (f) process.stdout.write(`\n${f}\n`)
    }
    printFooter()

    // ── REPL ──────────────────────────────────────────────────────────
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    rl.setPrompt(`\n${C.cyan}❯${C.reset} `)
    rl.prompt()

    let thinking = false

    const printReply = (): void => {
      try {
        const st = readState(runDir)
        const reply = st?.context?.[replyKey]
        if (reply) process.stdout.write(`\n${renderMarkdown(reply)}\n`)
        else process.stdout.write(`\n${C.dim}(no reply captured under context.${replyKey})${C.reset}\n`)
      } catch (err) {
        process.stdout.write(`\n${C.red}(failed to read state: ${err})${C.reset}\n`)
      }
      printFooter()
    }

    rl.on("line", async (raw) => {
      if (thinking) return
      const line = raw.trim()
      if (!line) { rl.prompt(); return }

      // Slash commands
      if (line === "/exit" || line === "/quit") {
        process.stdout.write(`\n${C.dim}paused at ${C.reset}${C.cyan}${runId}${C.reset}${C.dim}. reconnect with:${C.reset}\n  supertinker chat --workflow ${workflow} --run ${runId}\n`)
        rl.close()
        return
      }
      if (line === "/run")   { process.stdout.write(`${C.dim}runId:${C.reset} ${C.cyan}${runId}${C.reset}\n`); rl.prompt(); return }
      if (line === "/raw")   {
        try { process.stdout.write(`${C.dim}${readFileSync(join(runDir, "context.json"), "utf8")}${C.reset}\n`) } catch {}
        rl.prompt(); return
      }
      if (line === "/tail")   {
        try {
          const lines = readFileSync(join(runDir, "orchestrator.log"), "utf8").trim().split("\n")
          process.stdout.write(`${C.dim}${lines.slice(-20).join("\n")}${C.reset}\n`)
        } catch {}
        rl.prompt(); return
      }
      if (line === "/status") { printFooter(); rl.prompt(); return }
      if (line === "/help")   {
        process.stdout.write(
          `${C.dim}commands: ${C.reset}${C.cyan}/exit${C.reset} ${C.dim}leave · ${C.reset}` +
          `${C.cyan}/run${C.reset} ${C.dim}print runId · ${C.reset}` +
          `${C.cyan}/raw${C.reset} ${C.dim}dump context · ${C.reset}` +
          `${C.cyan}/tail${C.reset} ${C.dim}last 20 log lines · ${C.reset}` +
          `${C.cyan}/status${C.reset} ${C.dim}refresh active runs${C.reset}\n`,
        )
        rl.prompt(); return
      }

      // Inject + resume
      thinking = true
      const stopSpinner = startSpinner("thinking")
      try {
        const state = readState(runDir)
        state.context[contextKey] = line
        writeState(runDir, state)

        const code = await runChild(["resume", "--run", runId!, "--choice", choice, "--workflow", workflow, "--quiet"])
        stopSpinner()

        if (code !== 0) {
          process.stdout.write(`${C.red}(resume exited ${code})${C.reset}\n`)
        } else {
          printReply()
        }
      } catch (err) {
        stopSpinner()
        process.stdout.write(`${C.red}(error: ${err})${C.reset}\n`)
      } finally {
        thinking = false
        rl.prompt()
      }
    })

    rl.on("close", () => process.exit(0))
  },
}
