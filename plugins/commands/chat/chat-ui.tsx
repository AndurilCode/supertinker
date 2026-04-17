/**
 * chat-ui.tsx — Ink (React-for-terminal) UI for the chat command.
 *
 * Renders: scrollable conversation, auto-refreshing active-runs footer,
 * spinner while the agent is working, text input at the bottom. Drives
 * supertinker resume as a child process between turns; everything else is
 * state + effects in this component.
 */

import { useEffect, useState } from "react"
import { render, Box, Text, useInput, useApp } from "ink"
import Spinner from "ink-spinner"
import {
  existsSync, readFileSync, writeFileSync, statSync, readdirSync,
} from "fs"
import { join } from "path"
import { spawn } from "child_process"

const RUN_ROOT = "/tmp/orchestrator"

// ─── Minimal markdown → ANSI renderer (same one as before, unchanged) ─────
const C = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", italic: "\x1b[3m", underline: "\x1b[4m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", blue: "\x1b[34m",
  magenta: "\x1b[35m", cyan: "\x1b[36m", gray: "\x1b[90m", bgGray: "\x1b[100m",
}

function renderMarkdown(md: string): string {
  const lines = md.split("\n")
  const out: string[] = []
  let inFence = false, fenceLang = "", codeBuf: string[] = []
  const flushFence = () => {
    if (codeBuf.length === 0) return
    const top = fenceLang
      ? `${C.gray}┌─ ${fenceLang} ${"─".repeat(Math.max(1, 40 - fenceLang.length))}${C.reset}`
      : `${C.gray}┌${"─".repeat(42)}${C.reset}`
    const bot = `${C.gray}└${"─".repeat(43)}${C.reset}`
    out.push(top)
    for (const l of codeBuf) out.push(`${C.gray}│${C.reset} ${C.green}${l}${C.reset}`)
    out.push(bot)
    codeBuf = []; fenceLang = ""
  }
  const inline = (s: string): string => {
    s = s.replace(/`([^`]+)`/g, (_, code) => `${C.bgGray}${C.cyan} ${code} ${C.reset}`)
    s = s.replace(/\*\*([^*]+)\*\*/g, `${C.bold}$1${C.reset}`)
    s = s.replace(/__([^_]+)__/g,     `${C.bold}$1${C.reset}`)
    s = s.replace(/(^|[\s(])\*([^*\n]+)\*/g, `$1${C.italic}$2${C.reset}`)
    s = s.replace(/(^|[\s(])_([^_\n]+)_/g,   `$1${C.italic}$2${C.reset}`)
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, `${C.underline}${C.blue}$1${C.reset} ${C.dim}($2)${C.reset}`)
    return s
  }
  for (const raw of lines) {
    const fence = raw.match(/^```(\w*)\s*$/)
    if (fence) {
      if (inFence) { flushFence(); inFence = false }
      else         { inFence = true; fenceLang = fence[1] ?? "" }
      continue
    }
    if (inFence) { codeBuf.push(raw); continue }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) { out.push(`${C.gray}${"─".repeat(44)}${C.reset}`); continue }
    const h = raw.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      const level = h[1].length, text = inline(h[2])
      if (level === 1) out.push(`\n${C.bold}${C.underline}${text}${C.reset}`)
      else if (level === 2) out.push(`\n${C.bold}${C.yellow}${text}${C.reset}`)
      else out.push(`${C.bold}${text}${C.reset}`)
      continue
    }
    if (/^\s*>\s+/.test(raw)) { out.push(`${C.gray}│${C.reset} ${C.dim}${inline(raw.replace(/^\s*>\s+/, ""))}${C.reset}`); continue }
    const b = raw.match(/^(\s*)[-*+]\s+(.*)$/)
    if (b) { out.push(`${b[1]}${C.cyan}•${C.reset} ${inline(b[2])}`); continue }
    const n = raw.match(/^(\s*)(\d+\.)\s+(.*)$/)
    if (n) { out.push(`${n[1]}${C.cyan}${n[2]}${C.reset} ${inline(n[3])}`); continue }
    out.push(inline(raw))
  }
  if (inFence) flushFence()
  return out.join("\n")
}

// ─── Active-runs scan ─────────────────────────────────────────────────────
interface RunStatus {
  runId: string; currentNode: string
  status: "paused" | "running" | "stale" | "done" | "failed"
  mtimeMs: number; isCurrent: boolean
}

// Running runs go "stale" if the log hasn't been touched in a short window
// (killed processes leave logs frozen mid-INVOKE). Paused runs have a much
// longer window because pausing is intentional and durable — but we still
// don't want week-old paused runs polluting the footer.
const STALE_RUNNING_MS = Number(process.env.CHAT_STALE_RUNNING_MS ?? 120_000)     // 2 min
const STALE_PAUSED_MS  = Number(process.env.CHAT_STALE_PAUSED_MS  ?? 86_400_000)  // 24 h

function classifyRun(runDir: string, runId: string, currentRunId: string): RunStatus | null {
  try {
    const mtimeMs = statSync(runDir).mtimeMs
    if (existsSync(join(runDir, "state.json"))) {
      try {
        const s = JSON.parse(readFileSync(join(runDir, "state.json"), "utf8"))
        return { runId, currentNode: s.nodeId ?? "?", status: "paused", mtimeMs, isCurrent: runId === currentRunId }
      } catch {}
    }
    const logPath = join(runDir, "orchestrator.log")
    if (!existsSync(logPath)) return null
    const log = readFileSync(logPath, "utf8")
    if (/^\[[^\]]+\]\s+DONE\s+graph/m.test(log))   return { runId, currentNode: "done",   status: "done",   mtimeMs, isCurrent: runId === currentRunId }
    if (/^\[[^\]]+\]\s+FAILED\s+graph/m.test(log)) return { runId, currentNode: "failed", status: "failed", mtimeMs, isCurrent: runId === currentRunId }

    const logMtime = statSync(logPath).mtimeMs
    const lines = log.trim().split(/\r?\n/)
    let currentNode = "?"
    for (let i = lines.length - 1; i >= 0; i--) {
      const m = lines[i].match(/\]\s+(?:START|RESUME|INVOKE)\s+(\S+)/)
      if (m) { currentNode = m[1]; break }
    }
    const status: RunStatus["status"] = (Date.now() - logMtime < STALE_RUNNING_MS) ? "running" : "stale"
    return { runId, currentNode, status, mtimeMs: logMtime, isCurrent: runId === currentRunId }
  } catch { return null }
}

function scanActiveRuns(currentRunId: string, sessionStartMs: number): RunStatus[] {
  let entries: RunStatus[] = []
  try {
    for (const n of readdirSync(RUN_ROOT)) {
      const dir = join(RUN_ROOT, n)
      try { if (!statSync(dir).isDirectory()) continue } catch { continue }
      const s = classifyRun(dir, n, currentRunId)
      if (s) entries.push(s)
    }
  } catch { return [] }
  // Footer shows what belongs to *this chat session*: the current run plus
  // anything created or meaningfully updated since chat started — typically
  // workflows the director itself launched. Older paused runs are hidden
  // (they're still on disk, reachable via explicit --run <id>). Set
  // CHAT_STALE_PAUSED_MS to broaden the window (e.g. show the last 24 h).
  const now = Date.now()
  const pausedCutoff = process.env.CHAT_STALE_PAUSED_MS
    ? now - STALE_PAUSED_MS
    : sessionStartMs
  const active = entries.filter(e => {
    if (e.isCurrent) return true
    if (e.status === "running") return true   // classifier already applied the running-stale window
    if (e.status === "paused")  return e.mtimeMs >= pausedCutoff
    return false
  })
  active.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1
    if (!a.isCurrent && b.isCurrent) return 1
    return b.mtimeMs - a.mtimeMs
  })
  return active
}

// ─── Footer component ─────────────────────────────────────────────────────
function Footer({ runs }: { runs: RunStatus[] }) {
  if (runs.length === 0) return null
  const statusColor = (s: RunStatus["status"]): string =>
    s === "paused"  ? "yellow" :
    s === "running" ? "green"  :
    s === "failed"  ? "red"    :
    s === "stale"   ? "gray"   : "gray"

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
      <Text color="gray">
        runs ({runs.length})
      </Text>
      {runs.slice(0, 8).map((r) => (
        <Box key={r.runId}>
          <Text color="cyan">{r.isCurrent ? "● " : "  "}</Text>
          <Text color={statusColor(r.status)}>{r.status.padEnd(7)}</Text>
          <Text color="cyan"> {r.runId}</Text>
          <Text dimColor> @{r.currentNode}</Text>
        </Box>
      ))}
      {runs.length > 8 && (
        <Text dimColor>  …and {runs.length - 8} more</Text>
      )}
    </Box>
  )
}

// ─── State helpers ────────────────────────────────────────────────────────
function readState(runDir: string): any { return JSON.parse(readFileSync(join(runDir, "state.json"), "utf8")) }
function writeStateFile(runDir: string, state: any): void {
  writeFileSync(join(runDir, "state.json"), JSON.stringify(state, null, 2))
}

function supertinkerBin(): { cmd: string; args: string[] } {
  const self = process.argv[1] ?? "/Users/gpavanello/Repositories/supertinker/cli.ts"
  return { cmd: process.execPath, args: [self] }
}
function runResume(runId: string, choice: string, workflow: string): Promise<number> {
  const { cmd, args } = supertinkerBin()
  return new Promise((resolve) => {
    const p = spawn(cmd, [...args, "resume", "--run", runId, "--choice", choice, "--workflow", workflow, "--quiet"],
      { stdio: "ignore", env: process.env })
    p.on("exit", (code) => resolve(code ?? 0))
    p.on("error", () => resolve(1))
  })
}

// ─── Message list ─────────────────────────────────────────────────────────
interface Msg { role: "user" | "agent" | "system"; text: string }

// ─── Main component ───────────────────────────────────────────────────────
interface ChatProps {
  runId:      string
  workflow:   string
  choice:     string
  contextKey: string
  replyKey:   string
  initial?:   string
}

function Chat({ runId, workflow, choice, contextKey, replyKey, initial }: ChatProps) {
  const runDir = join(RUN_ROOT, runId)
  const { exit } = useApp()

  // Chat session start — used to scope the footer to "what happened during
  // this session" (current run + child workflows the director launched).
  // A hair of slack (1 minute earlier) covers the current run's own pause
  // which may have been written just before chat was opened.
  const sessionStartMs = Math.floor(Date.now() - 60_000)

  const [messages, setMessages] = useState<Msg[]>(
    initial ? [{ role: "agent", text: initial }] : [],
  )
  const [input, setInput]       = useState("")
  const [thinking, setThinking] = useState(false)
  const [runs, setRuns]         = useState<RunStatus[]>(() => scanActiveRuns(runId, sessionStartMs))

  // Refresh active runs every 2s
  useEffect(() => {
    const t = setInterval(() => setRuns(scanActiveRuns(runId, sessionStartMs)), 2000)
    return () => clearInterval(t)
  }, [runId, sessionStartMs])

  const submit = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed) return

    // Slash commands handled locally — no roundtrip
    if (trimmed === "/exit" || trimmed === "/quit") {
      setMessages(m => [...m, { role: "system", text: `paused at ${runId}. reconnect: supertinker chat --workflow ${workflow} --run ${runId}` }])
      setTimeout(() => exit(), 50)
      return
    }
    if (trimmed === "/help") {
      setMessages(m => [...m, { role: "system", text:
        "commands: /exit leave · /run print runId · /raw dump context · /tail last log lines · /status refresh footer" }])
      return
    }
    if (trimmed === "/run")    { setMessages(m => [...m, { role: "system", text: `runId: ${runId}` }]); return }
    if (trimmed === "/status") { setRuns(scanActiveRuns(runId, sessionStartMs)); return }
    if (trimmed === "/raw")    {
      try { setMessages(m => [...m, { role: "system", text: readFileSync(join(runDir, "context.json"), "utf8") }]) } catch {}
      return
    }
    if (trimmed === "/tail")   {
      try {
        const lines = readFileSync(join(runDir, "orchestrator.log"), "utf8").trim().split("\n")
        setMessages(m => [...m, { role: "system", text: lines.slice(-20).join("\n") }])
      } catch {}
      return
    }

    setMessages(m => [...m, { role: "user", text: trimmed }])
    setThinking(true)
    try {
      const state = readState(runDir)
      state.context[contextKey] = trimmed
      writeStateFile(runDir, state)
      const code = await runResume(runId, choice, workflow)
      if (code !== 0) {
        setMessages(m => [...m, { role: "system", text: `(resume exited ${code})` }])
      } else {
        try {
          const st = readState(runDir)
          const reply = st?.context?.[replyKey] ?? `(no reply captured under context.${replyKey})`
          setMessages(m => [...m, { role: "agent", text: reply }])
        } catch (err) {
          setMessages(m => [...m, { role: "system", text: `(failed to read state: ${err})` }])
        }
      }
    } finally {
      setThinking(false)
    }
  }

  useInput((char, key) => {
    if (key.ctrl && char === "c") { exit(); return }
    if (thinking) return
    if (key.return) { const v = input; setInput(""); void submit(v); return }
    if (key.backspace || key.delete) { setInput(i => i.slice(0, -1)); return }
    if (key.ctrl || key.meta) return
    if (char && char.length > 0) setInput(i => i + char)
  })

  return (
    <Box flexDirection="column">
      <Box flexDirection="column" marginBottom={1}>
        {messages.map((m, i) => (
          <Box key={i} flexDirection="column" marginBottom={1}>
            {m.role === "user" && (
              <Text><Text color="cyan" bold>❯ </Text><Text>{m.text}</Text></Text>
            )}
            {m.role === "agent" && (
              <Text>{renderMarkdown(m.text)}</Text>
            )}
            {m.role === "system" && (
              <Text dimColor>{m.text}</Text>
            )}
          </Box>
        ))}
      </Box>

      <Footer runs={runs} />

      <Box marginTop={1}>
        {thinking ? (
          <Text><Text color="cyan"><Spinner type="dots" /></Text><Text dimColor> thinking…</Text></Text>
        ) : (
          <Text><Text color="cyan" bold>❯ </Text><Text>{input}</Text><Text color="gray">▌</Text></Text>
        )}
      </Box>
    </Box>
  )
}

// ─── Public entrypoint ────────────────────────────────────────────────────
export interface MountOpts {
  runId:      string
  workflow:   string
  choice:     string
  contextKey: string
  replyKey:   string
  initial?:   string
}

export function mountChat(opts: MountOpts): void {
  render(<Chat {...opts} />)
}
