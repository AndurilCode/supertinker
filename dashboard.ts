/**
 * dashboard.ts — Raw ANSI terminal dashboard (no Ink/React)
 *
 * Renders by clearing screen and redrawing each frame. Resilient to /dev/tty
 * interference from child processes (claude CLI) because each frame starts
 * from cursor home and clears garbage below.
 */

import { existsSync, watch, readFileSync, openSync, readSync, closeSync, writeFileSync, writeSync, statSync, readdirSync } from "fs"
import { join } from "path"
import type { DisplayEvent, TranscriptMapper, ProviderMeta } from "./display-protocol.js"

// ─── ANSI HELPERS

const ESC = "\x1b["
const HIDE_CURSOR = `${ESC}?25l`
const SHOW_CURSOR = `${ESC}?25h`
const HOME = `${ESC}H`
const CLEAR_BELOW = `${ESC}J`
const ALT_SCREEN_ON  = `${ESC}?1049h`  // enter alternate screen buffer (disables trackpad scroll)
const ALT_SCREEN_OFF = `${ESC}?1049l`  // exit alternate screen buffer
const RESET = `${ESC}0m`
const BOLD = `${ESC}1m`
const DIM = `${ESC}2m`
const CYAN = `${ESC}36m`
const GREEN = `${ESC}32m`
const YELLOW = `${ESC}33m`
const RED = `${ESC}31m`

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

// ─── FILE TAILING

class FileTailer {
  private offset = 0
  private lines: string[] = []
  private watcher: ReturnType<typeof watch> | null = null
  private pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(private filePath: string, private maxLines: number) {
    this.startWatching()
  }

  getLines(): string[] { return this.lines }

  private readNew() {
    if (!existsSync(this.filePath)) return
    try {
      const stat = statSync(this.filePath)
      if (stat.size <= this.offset) return
      const fd = openSync(this.filePath, "r")
      const buf = Buffer.alloc(stat.size - this.offset)
      readSync(fd, buf, 0, buf.length, this.offset)
      closeSync(fd)
      this.offset = stat.size
      const newLines = buf.toString("utf8").split("\n").filter(l => l.length > 0)
      if (newLines.length > 0) {
        this.lines = [...this.lines, ...newLines].slice(-this.maxLines)
      }
    } catch {}
  }

  private startWatching() {
    if (!existsSync(this.filePath)) {
      this.pollInterval = setInterval(() => {
        if (existsSync(this.filePath)) {
          clearInterval(this.pollInterval!)
          this.pollInterval = null
          this.readNew()
          this.startWatching()
        }
      }, 200)
      return
    }
    this.readNew()
    try {
      this.watcher = watch(this.filePath, () => this.readNew())
    } catch {}
  }

  destroy() {
    if (this.watcher) this.watcher.close()
    if (this.pollInterval) clearInterval(this.pollInterval)
  }
}

// ─── TYPES

interface PipelineEvent {
  ts: string
  event: string
  runId: string
  [key: string]: unknown
}

type RunStatus = "starting" | "running" | "paused" | "done" | "failed"

interface AgentState {
  nodeId: string
  agent: string
  provider: string
  startedAt: number
  metaPath: string
  logFile: string
}

interface PipelineState {
  status: RunStatus
  workflowId: string
  runId: string
  startedAt: number
  completedNodes: Set<string>
  activeAgents: Map<string, AgentState>
  forkTargets: Map<string, string[]>
  pauseReason?: string
  error?: string
  graph?: { nodes: Array<{ id: string }> }
  subPaused?: { workflowId: string; nodeId: string; reason?: string }
}

// ─── TRANSCRIPT STREAM

class TranscriptStream {
  private mapper: TranscriptMapper | null = null
  private tailer: FileTailer | null = null
  private events: DisplayEvent[] = []
  private loaded = false

  constructor(
    private metaPath: string,
    private logFile: string,
    private loadMapper: (provider: string) => Promise<TranscriptMapper | null>,
    private maxEvents: number,
  ) {
    this.tryLoad()
  }

  private findTranscriptFile(meta: any): string | null {
    // If meta has a direct transcriptPath, use it
    if (meta.transcriptPath && existsSync(meta.transcriptPath)) return meta.transcriptPath
    // Search Claude project dirs for the session transcript
    if (meta.claudeProjects && meta.transcriptFile) {
      try {
        for (const dir of readdirSync(meta.claudeProjects)) {
          const candidate = join(meta.claudeProjects, dir, meta.transcriptFile)
          if (existsSync(candidate)) return candidate
        }
      } catch {}
    }
    return null
  }

  private async tryLoad() {
    const poll = setInterval(async () => {
      if (this.loaded) { clearInterval(poll); return }
      if (!existsSync(this.metaPath)) return
      try {
        const meta = JSON.parse(readFileSync(this.metaPath, "utf8"))
        this.mapper = await this.loadMapper(meta.provider)
        const tp = this.findTranscriptFile(meta)
        if (tp) {
          this.tailer = new FileTailer(tp, 200)
          this.loaded = true
          clearInterval(poll)
        }
      } catch {}
    }, 200)
    // Keep trying for 60s — transcript may take time to appear
    setTimeout(() => clearInterval(poll), 60000)
  }

  getDisplayLines(maxLines: number): string[] {
    if (this.mapper && this.tailer) {
      const events: DisplayEvent[] = []
      for (const line of this.tailer.getLines()) {
        const result = this.mapper(line)
        if (result === null) continue
        if (Array.isArray(result)) events.push(...result)
        else events.push(result)
      }
      return events.slice(-maxLines).map(formatDisplayEvent)
    }
    // Fallback: raw log file
    if (!this.tailer && existsSync(this.logFile)) {
      this.tailer = new FileTailer(this.logFile, 30)
    }
    return this.tailer?.getLines().slice(-maxLines) ?? []
  }

  destroy() {
    this.tailer?.destroy()
  }
}

// ─── EVENT PARSING

function parseEvents(runDir: string, tailers: Map<string, FileTailer>): PipelineEvent[] {
  // Ensure main events tailer
  const mainKey = "main"
  if (!tailers.has(mainKey)) {
    tailers.set(mainKey, new FileTailer(join(runDir, "events.ndjson"), 500))
  }

  // Discover sub-workflow directories
  if (existsSync(runDir)) {
    try {
      for (const entry of readdirSync(runDir)) {
        if (!entry.startsWith("sub-")) continue
        const subDir = join(runDir, entry)
        if (!tailers.has(entry) && statSync(subDir).isDirectory()) {
          tailers.set(entry, new FileTailer(join(subDir, "events.ndjson"), 500))
        }
      }
    } catch {}
  }

  const allLines: string[] = []
  for (const tailer of tailers.values()) {
    allLines.push(...tailer.getLines())
  }

  const events: PipelineEvent[] = []
  for (const line of allLines) {
    try { events.push(JSON.parse(line)) } catch {}
  }
  events.sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime())
  return events
}

function derivePipelineState(events: PipelineEvent[], runDir: string): PipelineState {
  const completedNodes = new Set<string>()
  const activeAgents = new Map<string, AgentState>()
  const forkTargets = new Map<string, string[]>()
  let status: RunStatus = "starting"
  let workflowId = ""
  let mainRunId = ""
  let startedAt = Date.now()
  let pauseReason: string | undefined
  let error: string | undefined
  let graph: { nodes: Array<{ id: string }> } | undefined
  let subPaused: { workflowId: string; nodeId: string; reason?: string } | undefined

  // Track active sub-workflows for display-name prefixing
  const activeSubWorkflows = new Map<string, string>() // runId prefix -> innerWorkflowId

  for (const evt of events) {
    const evtRunId = evt.runId as string ?? ""
    const isSub = evtRunId.includes("/")

    // Determine display key: prefix sub-workflow node IDs to avoid collisions
    const rawNodeId = evt.nodeId as string | undefined
    let subPrefix = ""
    if (isSub && rawNodeId) {
      const subRunId = evtRunId.split("/").slice(1).join("/")
      subPrefix = (activeSubWorkflows.get(subRunId) ?? subRunId) + "/"
    }
    const displayNodeId = rawNodeId ? subPrefix + rawNodeId : undefined

    if (!isSub) mainRunId = evtRunId

    if (evt.event === "RunStart" && !isSub) {
      status = "running"
      workflowId = (evt.workflow as string) ?? ""
      startedAt = new Date(evt.ts).getTime()
      const wf = evt.workflow as any
      if (wf?.graph?.nodes) graph = wf.graph
    }

    if (evt.event === "SubworkflowStart") {
      const innerWfId = evt.innerWorkflowId as string
      if (innerWfId) {
        activeSubWorkflows.set(innerWfId, innerWfId)
      }
    }

    if (evt.event === "PreAgent" && displayNodeId) {
      const agent = evt.agent as string
      const provider = evt.provider as string
      let agentDir = runDir
      if (isSub) {
        const subId = evtRunId.split("/").slice(1).join("/")
        const subDir = join(runDir, `sub-${subId}`)
        if (existsSync(subDir)) agentDir = subDir
      }
      activeAgents.set(displayNodeId, {
        nodeId: displayNodeId, agent, provider,
        startedAt: new Date(evt.ts).getTime(),
        metaPath: join(agentDir, `${rawNodeId}.meta.json`),
        logFile: join(agentDir, `${rawNodeId}.log`),
      })
      if (status === "starting") status = "running"
    }

    if (evt.event === "PostAgent" && displayNodeId) {
      completedNodes.add(displayNodeId)
      activeAgents.delete(displayNodeId)
    }

    if (evt.event === "ForkStart" && displayNodeId) {
      forkTargets.set(displayNodeId, evt.targets as string[])
    }

    if (evt.event === "Paused") {
      if (isSub) {
        // Sub-workflow pause — track separately so outer status isn't overwritten
        const subId = evtRunId.split("/").slice(1).join("/")
        subPaused = {
          workflowId: activeSubWorkflows.get(subId) ?? subId,
          nodeId: rawNodeId ?? "?",
          reason: evt.reason as string | undefined,
        }
      } else {
        status = "paused"
        pauseReason = evt.reason as string | undefined
      }
    }

    if (evt.event === "Resumed") {
      if (isSub) {
        subPaused = undefined
      } else {
        status = "running"
        pauseReason = undefined
      }
    }

    if (evt.event === "RunEnd" && !isSub) {
      status = (evt.terminal as string) === "done" ? "done" : "failed"
    }

    if (evt.event === "Error") {
      error = evt.error as string
    }
  }

  return {
    status, workflowId, runId: mainRunId, startedAt, completedNodes,
    activeAgents, forkTargets, pauseReason, error, graph, subPaused,
  }
}

// ─── DISPLAY EVENT FORMATTING

/** Strip newlines and collapse whitespace for single-line display */
function oneline(s: string): string {
  return s.replace(/\n/g, " ").replace(/\s+/g, " ").trim()
}

/** Wrap a string to fit within `maxWidth` visible chars, returning multiple lines.
 *  Preserves ANSI codes across line breaks. */
function wordWrap(str: string, maxWidth: number): string[] {
  if (maxWidth <= 0) return [str]
  const lines: string[] = []
  let remaining = str
  while (remaining.length > 0) {
    const vis = visLen(remaining)
    if (vis <= maxWidth) { lines.push(remaining); break }
    // Find the split point at maxWidth visible chars
    let visCount = 0
    let splitIdx = 0
    for (let i = 0; i < remaining.length; i++) {
      if (remaining[i] === "\x1b" && remaining[i + 1] === "[") {
        const end = remaining.indexOf("m", i)
        if (end !== -1) { i = end; continue }
      }
      visCount++
      if (visCount >= maxWidth) { splitIdx = i + 1; break }
    }
    if (splitIdx === 0) break
    lines.push(remaining.slice(0, splitIdx) + RESET)
    remaining = remaining.slice(splitIdx)
  }
  return lines.length === 0 ? [""] : lines
}

function formatDisplayEvent(evt: DisplayEvent): string {
  switch (evt.t) {
    case "thinking": return `${DIM}  ${evt.text}${RESET}`
    case "text": return evt.text
    case "tool_start": {
      const argStr = Object.entries(evt.args).map(([k, v]) => `${k}=${v}`).join(" ")
      return `${YELLOW}[${evt.name}]${RESET} ${argStr}`
    }
    case "tool_end": return `${DIM}  -> ${evt.result}${RESET}`
    case "subagent_start": return `>> ${evt.name}: ${evt.desc}`
    case "subagent_end": return `<< ${evt.id} (${evt.tools} tools, ${Math.round(evt.duration_ms / 1000)}s)`
    case "error": return `${RED}ERROR: ${evt.text}${RESET}`
    case "start": return `Starting ${evt.provider}${evt.model ? ` (${evt.model})` : ""}`
    case "end": return "Agent finished"
  }
}

/** Convert display lines into wrapped box-ready lines */
function wrapDisplayLines(displayLines: string[], innerWidth: number): string[] {
  const wrapped: string[] = []
  for (const line of displayLines) {
    // Split on actual newlines first, then word-wrap each part
    const parts = line.split("\n")
    for (const part of parts) {
      const trimmed = part.replace(/\s+$/, "")
      if (trimmed.length === 0) { wrapped.push(""); continue }
      wrapped.push(...wordWrap(trimmed, innerWidth))
    }
  }
  return wrapped
}

// ─── FRAME BUILDER

function elapsed(ms: number): string {
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  const h = Math.floor(ms / 3600000)
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

function agentElapsed(ms: number): string {
  const s = Math.floor(ms / 1000) % 60
  const m = Math.floor(ms / 60000) % 60
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
}

function hline(ch: string, width: number): string {
  return ch.repeat(width)
}

function stripAnsi(str: string): string {
  return str.replace(/\x1b\[[0-9;]*m/g, "")
}

function visLen(str: string): number {
  return stripAnsi(str).length
}

/** Truncate string to `max` visible chars, preserving ANSI codes */
function truncate(str: string, max: number): string {
  let vis = 0
  let i = 0
  while (i < str.length && vis < max) {
    if (str[i] === "\x1b" && str[i + 1] === "[") {
      const end = str.indexOf("m", i)
      if (end !== -1) { i = end + 1; continue }
    }
    vis++
    i++
  }
  // Include any trailing ANSI reset
  let tail = ""
  if (i < str.length && str.slice(i).startsWith("\x1b[")) {
    const end = str.indexOf("m", i)
    if (end !== -1) tail = str.slice(i, end + 1)
  }
  return str.slice(0, i) + tail + RESET
}

/** Pad or truncate to exactly `width` visible chars */
function fitTo(str: string, width: number): string {
  const len = visLen(str)
  if (len > width) return truncate(str, width)
  return str + " ".repeat(width - len)
}

/** Build a box line: │ left...........right │ */
function boxLR(left: string, right: string, w: number): string {
  const inner = w - 4
  const leftLen = visLen(left)
  const rightLen = visLen(right)
  const gap = Math.max(1, inner - leftLen - rightLen)
  const content = truncate(left, inner - rightLen - 1) + " ".repeat(gap) + right
  return `│ ${fitTo(content, inner)} │`
}

/** Build a box line: │ content                │ */
function boxLine(content: string, w: number): string {
  return `│ ${fitTo(content, w - 4)} │`
}

function buildFrame(
  state: PipelineState, transcripts: Map<string, TranscriptStream>,
  spinnerIdx: number, cols: number, rows: number,
): string {
  const lines: string[] = []
  const w = cols
  const innerW = w - 4  // usable width inside box borders

  // ── Header (3 lines)
  const elapsedStr = elapsed(Date.now() - state.startedAt)
  const wfId = state.workflowId || "..."
  const rId = state.runId.slice(0, 30) || "..."
  lines.push(`┌${hline("─", w - 2)}┐`)
  lines.push(boxLR(
    `${BOLD}${CYAN}supertinker${RESET}  ${DIM}${wfId}${RESET}  ${rId}`,
    `${BOLD}${elapsedStr}${RESET}`,
    w
  ))
  lines.push(`└${hline("─", w - 2)}┘`)

  // ── Progress bar with node counter (1-2 lines)
  const spinner = SPINNER_FRAMES[spinnerIdx % SPINNER_FRAMES.length]
  const totalNodes = state.graph?.nodes?.length ?? 0
  const completedCount = state.completedNodes.size
  const activeCount = state.activeAgents.size
  const counterStr = totalNodes > 0
    ? `${DIM}[${completedCount}/${totalNodes}]${RESET} `
    : ""

  const nodeStrs: string[] = []
  for (const id of state.completedNodes) nodeStrs.push(`${GREEN}✓ ${id}${RESET}`)
  for (const id of state.activeAgents.keys()) nodeStrs.push(`${YELLOW}${spinner} ${id}${RESET}`)
  const progressLine = nodeStrs.length > 0
    ? counterStr + nodeStrs.join(` ${DIM}→${RESET} `)
    : `${DIM}Waiting for pipeline events...${RESET}`
  lines.push(` ${truncate(progressLine, w - 2)}`)

  // Error / pause / sub-workflow pause
  if (state.error) lines.push(` ${truncate(`${RED}Error: ${state.error}${RESET}`, w - 2)}`)
  if (state.pauseReason) lines.push(` ${truncate(`${YELLOW}Paused: ${state.pauseReason}${RESET}`, w - 2)}`)
  if (state.subPaused) {
    const sp = state.subPaused
    const subMsg = sp.reason
      ? `Sub-workflow ${sp.workflowId} paused at ${sp.nodeId}: ${sp.reason}`
      : `Sub-workflow ${sp.workflowId} paused at ${sp.nodeId}`
    lines.push(` ${truncate(`${YELLOW}⚠ ${subMsg}${RESET}`, w - 2)}`)
  }

  // ── Control bar (3 lines) — calculate early so we know remaining space
  const controlBarHeight = 3

  // ── Calculate available space for agent panels
  const usedLines = lines.length + controlBarHeight
  let availableRows = Math.max(4, rows - usedLines)

  // ── Agent panels
  const agents = Array.from(state.activeAgents.values())

  if (agents.length === 0 && state.status !== "done" && state.status !== "failed") {
    lines.push(``)
    lines.push(` ${DIM}Waiting for agent...${RESET}`)
    lines.push(``)
  }

  // Auto-focus the only active agent, or keep current focus if valid
  if (agents.length === 1) {
    focusedAgent = agents[0].nodeId
  } else if (focusedAgent && !state.activeAgents.has(focusedAgent)) {
    focusedAgent = agents.length > 0 ? agents[0].nodeId : null
  }

  if (agents.length > 0) {
    // Each panel needs at minimum: 3 lines (top border + header + bottom border) + 1 content line
    const panelOverhead = 3  // top border, header, bottom border
    const minContentLines = 2
    const perPanel = Math.max(
      minContentLines + panelOverhead,
      Math.floor(availableRows / agents.length),
    )

    for (const agent of agents) {
      const key = agent.nodeId
      if (!transcripts.has(key)) {
        transcripts.set(key, new TranscriptStream(agent.metaPath, agent.logFile, loadMapperFn!, 200))
      }
      const ts = transcripts.get(key)!

      const contentHeight = perPanel - panelOverhead
      // Get more lines than we need so we can scroll through them
      const rawLines = ts.getDisplayLines(500)
      const allWrapped = wrapDisplayLines(rawLines, innerW)

      // Scroll support
      if (!scrollOffsets.has(key)) scrollOffsets.set(key, 0)
      const scrollOff = scrollOffsets.get(key)!
      const totalWrapped = allWrapped.length
      const maxScroll = Math.max(0, totalWrapped - contentHeight)
      // scrollOff=0 means pinned to bottom (latest), positive = scrolled up
      const clampedScroll = Math.min(scrollOff, maxScroll)
      scrollOffsets.set(key, clampedScroll)

      const startIdx = Math.max(0, totalWrapped - contentHeight - clampedScroll)
      const visibleLines = allWrapped.slice(startIdx, startIdx + contentHeight)

      const ae = agentElapsed(Date.now() - agent.startedAt)
      const isFocused = focusedAgent === key
      const focusIndicator = (agents.length > 1 && isFocused) ? `${CYAN}▸${RESET} ` : ""

      // Scroll indicators
      const canScrollUp = startIdx > 0
      const canScrollDown = clampedScroll > 0
      const scrollHint = (canScrollUp || canScrollDown)
        ? ` ${DIM}${canScrollUp ? "▲" : " "}${canScrollDown ? "▼" : " "}${RESET}`
        : ""

      lines.push(`╭${hline("─", w - 2)}╮`)
      lines.push(boxLR(
        `${focusIndicator}${BOLD}${GREEN}${spinner} ${agent.agent}${RESET}`,
        `${DIM}${agent.provider}${RESET}  ${ae}${scrollHint}`,
        w
      ))

      if (visibleLines.length === 0) {
        lines.push(boxLine(`${DIM}Waiting for transcript...${RESET}`, w))
        // Fill remaining content height
        for (let i = 1; i < contentHeight; i++) lines.push(boxLine("", w))
      } else {
        for (const pl of visibleLines) {
          lines.push(boxLine(pl, w))
        }
        // Pad if fewer lines than content height
        for (let i = visibleLines.length; i < contentHeight; i++) {
          lines.push(boxLine("", w))
        }
      }
      lines.push(`╰${hline("─", w - 2)}╯`)
    }
  }

  // ── Control bar
  // Derive effective status: if outer is "done" but a sub-workflow paused, show warning
  const hasSubPause = !!state.subPaused
  const effectiveStatus = (state.status === "done" && hasSubPause) ? "done (sub paused)" : state.status
  const statusColor = state.status === "running" ? GREEN
    : state.status === "paused" ? YELLOW
    : (state.status === "done" && hasSubPause) ? YELLOW
    : state.status === "done" ? CYAN
    : state.status === "failed" ? RED : ""

  const scrollKeys = agents.length > 0
    ? `  ${DIM}[↑/↓]${RESET} scroll`
    : ""
  const tabKey = agents.length > 1
    ? `  ${DIM}[tab]${RESET} focus`
    : ""

  lines.push(`┌${hline("─", w - 2)}┐`)
  lines.push(boxLR(
    `${DIM}[p]${RESET} pause  ${DIM}[r]${RESET} resume  ${DIM}[q]${RESET} quit${scrollKeys}${tabKey}`,
    `${BOLD}${statusColor}${effectiveStatus.toUpperCase()}${RESET}`,
    w
  ))
  lines.push(`└${hline("─", w - 2)}┘`)

  return lines.join("\n")
}

// ─── MODULE STATE (set by renderDashboard)

let loadMapperFn: ((provider: string) => Promise<TranscriptMapper | null>) | null = null

// Scroll state: per-agent scroll offset (0 = pinned to bottom / latest)
const scrollOffsets = new Map<string, number>()
let focusedAgent: string | null = null  // which agent panel is focused for scrolling

// ─── PUBLIC API

export interface DashboardOptions {
  runDir: string
  runWorkflow: () => Promise<void>
  resumeWorkflow?: (choice: string) => Promise<void>
  loadMapper: (provider: string) => Promise<TranscriptMapper | null>
}

export function renderDashboard(opts: DashboardOptions): void {
  loadMapperFn = opts.loadMapper
  const { runDir } = opts

  // Raw write to fd 1 — bypasses process.stdout (which is suppressed)
  const write = (s: string) => {
    try { writeSync(1, s) } catch {}
  }

  write(ALT_SCREEN_ON + HIDE_CURSOR)

  const eventTailers = new Map<string, FileTailer>()
  const transcripts = new Map<string, TranscriptStream>()
  let spinnerIdx = 0

  // Render loop
  const renderInterval = setInterval(() => {
    spinnerIdx++
    const cols = process.stderr.columns || process.stdout.columns || 80
    const rows = process.stderr.rows || process.stdout.rows || 24
    const events = parseEvents(runDir, eventTailers)
    const state = derivePipelineState(events, runDir)
    const frame = buildFrame(state, transcripts, spinnerIdx, cols, rows)

    // Atomic write: home + frame + clear below
    write(HOME + frame + "\n" + CLEAR_BELOW)
  }, 200)

  // Keybindings
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding("utf8")
    process.stdin.on("data", (key: string) => {
      if (key === "p") {
        writeFileSync(join(runDir, "pause-requested"), "")
      }
      if (key === "q" || key === "\x03") {
        clearInterval(renderInterval)
        write(ALT_SCREEN_OFF + SHOW_CURSOR)
        process.exit(0)
      }
      // Scroll up (arrow up or k)
      if (key === "\x1b[A" || key === "k") {
        if (focusedAgent) {
          const cur = scrollOffsets.get(focusedAgent) ?? 0
          scrollOffsets.set(focusedAgent, cur + 3)
        }
      }
      // Scroll down (arrow down or j)
      if (key === "\x1b[B" || key === "j") {
        if (focusedAgent) {
          const cur = scrollOffsets.get(focusedAgent) ?? 0
          scrollOffsets.set(focusedAgent, Math.max(0, cur - 3))
        }
      }
      // Tab to cycle focus between agent panels
      if (key === "\t") {
        const events = parseEvents(runDir, eventTailers)
        const state = derivePipelineState(events, runDir)
        const agentIds = Array.from(state.activeAgents.keys())
        if (agentIds.length > 1) {
          const curIdx = focusedAgent ? agentIds.indexOf(focusedAgent) : -1
          focusedAgent = agentIds[(curIdx + 1) % agentIds.length]
        }
      }
      // Home: scroll to bottom (latest)
      if (key === "\x1b[H" || key === "g") {
        if (focusedAgent) scrollOffsets.set(focusedAgent, 0)
      }
      // End: scroll to top (oldest)
      if (key === "\x1b[F" || key === "G") {
        if (focusedAgent) scrollOffsets.set(focusedAgent, 99999)
      }
    })
  }

  // Run workflow
  opts.runWorkflow().catch(err => {
    const msg = err instanceof Error ? err.message : String(err)
    if (!msg.includes("failed terminal")) {
      write(`\n${RED}Workflow error: ${msg}${RESET}\n`)
    }
  }).finally(() => {
    // Keep rendering for a bit after completion so user sees final state
    setTimeout(() => {
      clearInterval(renderInterval)
      // One final render
      const cols = process.stderr.columns || process.stdout.columns || 80
      const rows = process.stderr.rows || process.stdout.rows || 24
      const events = parseEvents(runDir, eventTailers)
      const state = derivePipelineState(events, runDir)
      const frame = buildFrame(state, transcripts, spinnerIdx, cols, rows)
      write(HOME + frame + "\n" + CLEAR_BELOW + ALT_SCREEN_OFF + SHOW_CURSOR)
    }, 1000)
  })
}
