import React, { useState, useEffect, useRef } from "react"
import { render, Box, Text, useInput, useApp, useStdout } from "ink"
import Spinner from "ink-spinner"
import { existsSync, watch, readFileSync, openSync, readSync, closeSync, writeFileSync, statSync } from "fs"
import { join } from "path"
import type { DisplayEvent, TranscriptMapper, ProviderMeta } from "./display-protocol.js"

// ─── TYPES AND FILE TAILING HOOKS (Task 6)

export interface PipelineEvent {
  ts: string
  event: string
  runId: string
  [key: string]: unknown
}

export function useFileTail(filePath: string | null, maxLines = 50): string[] {
  const [lines, setLines] = useState<string[]>([])
  const offsetRef = useRef(0)

  useEffect(() => {
    if (!filePath) return
    offsetRef.current = 0
    setLines([])

    function readNew() {
      if (!filePath || !existsSync(filePath)) return
      try {
        const stat = statSync(filePath)
        if (stat.size <= offsetRef.current) return
        const fd = openSync(filePath, "r")
        const buf = Buffer.alloc(stat.size - offsetRef.current)
        readSync(fd, buf, 0, buf.length, offsetRef.current)
        closeSync(fd)
        offsetRef.current = stat.size
        const newText = buf.toString("utf8")
        const newLines = newText.split("\n").filter(l => l.length > 0)
        if (newLines.length > 0) {
          setLines(prev => {
            const combined = [...prev, ...newLines]
            return combined.slice(-maxLines)
          })
        }
      } catch {}
    }

    readNew()

    let watcher: ReturnType<typeof watch> | null = null

    function startWatching() {
      if (!filePath) return
      if (!existsSync(filePath)) {
        const interval = setInterval(() => {
          if (filePath && existsSync(filePath)) {
            clearInterval(interval)
            readNew()
            startWatching()
          }
        }, 200)
        return
      }
      try {
        watcher = watch(filePath, () => readNew())
      } catch {}
    }

    startWatching()

    return () => {
      if (watcher) watcher.close()
    }
  }, [filePath, maxLines])

  return lines
}

export function useEventStream(runDir: string | null): PipelineEvent[] {
  const filePath = runDir ? join(runDir, "events.ndjson") : null
  const rawLines = useFileTail(filePath, 500)

  const [events, setEvents] = useState<PipelineEvent[]>([])

  useEffect(() => {
    const parsed: PipelineEvent[] = []
    for (const line of rawLines) {
      try { parsed.push(JSON.parse(line)) } catch {}
    }
    setEvents(parsed)
  }, [rawLines])

  return events
}

export function useTranscriptStream(
  metaPath: string | null,
  loadMapper: (provider: string) => Promise<TranscriptMapper | null>,
  maxEvents = 50,
): DisplayEvent[] {
  const [displayEvents, setDisplayEvents] = useState<DisplayEvent[]>([])
  const [transcriptPath, setTranscriptPath] = useState<string | null>(null)
  const [mapper, setMapper] = useState<TranscriptMapper | null>(null)

  useEffect(() => {
    if (!metaPath) return
    setDisplayEvents([])
    setTranscriptPath(null)
    setMapper(null)

    function tryLoadMeta() {
      if (!metaPath || !existsSync(metaPath)) return false
      try {
        const meta: ProviderMeta = JSON.parse(readFileSync(metaPath, "utf8"))
        setTranscriptPath(meta.transcriptPath)
        loadMapper(meta.provider).then(m => {
          if (m) setMapper(() => m)
        })
        return true
      } catch { return false }
    }

    if (tryLoadMeta()) return

    const interval = setInterval(() => {
      if (tryLoadMeta()) clearInterval(interval)
    }, 200)

    const timeout = setTimeout(() => clearInterval(interval), 5000)

    return () => {
      clearInterval(interval)
      clearTimeout(timeout)
    }
  }, [metaPath])

  const rawLines = useFileTail(transcriptPath, 200)

  useEffect(() => {
    if (!mapper) return
    const events: DisplayEvent[] = []
    for (const line of rawLines) {
      const result = mapper(line)
      if (result === null) continue
      if (Array.isArray(result)) events.push(...result)
      else events.push(result)
    }
    setDisplayEvents(events.slice(-maxEvents))
  }, [rawLines, mapper, maxEvents])

  return displayEvents
}

// ─── PIPELINE STATE (Task 7)

export type RunStatus = "starting" | "running" | "paused" | "done" | "failed"

export interface AgentState {
  nodeId: string
  agent: string
  provider: string
  startedAt: number
  metaPath: string
  logFile: string
}

export interface PipelineState {
  status: RunStatus
  workflowId: string
  runId: string
  startedAt: number
  completedNodes: Set<string>
  activeAgents: Map<string, AgentState>
  forkTargets: Map<string, string[]>
  pauseReason?: string
  error?: string
}

export function usePipelineState(events: PipelineEvent[], runDir: string): PipelineState {
  const [state, setState] = useState<PipelineState>({
    status: "starting",
    workflowId: "",
    runId: "",
    startedAt: Date.now(),
    completedNodes: new Set(),
    activeAgents: new Map(),
    forkTargets: new Map(),
  })

  useEffect(() => {
    const completedNodes = new Set<string>()
    const activeAgents = new Map<string, AgentState>()
    const forkTargets = new Map<string, string[]>()
    let status: RunStatus = "starting"
    let workflowId = ""
    let runId = ""
    let startedAt = Date.now()
    let pauseReason: string | undefined
    let error: string | undefined

    for (const evt of events) {
      runId = evt.runId ?? runId

      if (evt.event === "RunStart") {
        status = "running"
        workflowId = (evt.workflow as string) ?? ""
        startedAt = new Date(evt.ts).getTime()
      }

      if (evt.event === "PreAgent") {
        const nodeId = evt.nodeId as string
        const agent = evt.agent as string
        const provider = evt.provider as string
        activeAgents.set(nodeId, {
          nodeId, agent, provider,
          startedAt: new Date(evt.ts).getTime(),
          metaPath: join(runDir, `${nodeId}.meta.json`),
          logFile: join(runDir, `${nodeId}.log`),
        })
        if (status === "starting") status = "running"
      }

      if (evt.event === "PostAgent") {
        const nodeId = evt.nodeId as string
        completedNodes.add(nodeId)
        activeAgents.delete(nodeId)
      }

      if (evt.event === "ForkStart") {
        forkTargets.set(evt.nodeId as string, evt.targets as string[])
      }

      if (evt.event === "Paused") {
        status = "paused"
        pauseReason = evt.reason as string | undefined
      }

      if (evt.event === "Resumed") {
        status = "running"
        pauseReason = undefined
      }

      if (evt.event === "RunEnd") {
        const terminal = evt.terminal as string
        status = terminal === "done" ? "done" : "failed"
      }

      if (evt.event === "Error") {
        error = evt.error as string
      }
    }

    setState({ status, workflowId, runId, startedAt, completedNodes, activeAgents, forkTargets, pauseReason, error })
  }, [events, runDir])

  return state
}

// ─── UI COMPONENTS (Task 8)

function PipelineProgress({ state }: { state: PipelineState }) {
  const { completedNodes, activeAgents, forkTargets } = state

  const nodeStates: Array<{ id: string; status: "done" | "active" | "pending" }> = []
  for (const id of completedNodes) {
    nodeStates.push({ id, status: "done" })
  }
  for (const id of activeAgents.keys()) {
    nodeStates.push({ id, status: "active" })
  }

  if (nodeStates.length === 0) {
    return <Box paddingX={1}><Text dimColor>Waiting for pipeline events...</Text></Box>
  }

  return (
    <Box paddingX={1} flexWrap="wrap">
      {nodeStates.map((node, i) => {
        const sep = i > 0 ? <Text dimColor> {"->"} </Text> : null
        const forkLabel = forkTargets.has(node.id) ? <Text dimColor> [fork]</Text> : null
        if (node.status === "done") {
          return <React.Fragment key={node.id}>{sep}<Text color="green">{"✓"} {node.id}</Text>{forkLabel}</React.Fragment>
        }
        if (node.status === "active") {
          return <React.Fragment key={node.id}>{sep}<Text color="yellow"><Spinner type="dots" /> {node.id}</Text>{forkLabel}</React.Fragment>
        }
        return <React.Fragment key={node.id}>{sep}<Text dimColor>{node.id}</Text>{forkLabel}</React.Fragment>
      })}
    </Box>
  )
}

function Header({ state }: { state: PipelineState }) {
  const [elapsed, setElapsed] = useState("")

  useEffect(() => {
    const interval = setInterval(() => {
      const ms = Date.now() - state.startedAt
      const s = Math.floor(ms / 1000) % 60
      const m = Math.floor(ms / 60000) % 60
      const h = Math.floor(ms / 3600000)
      setElapsed(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [state.startedAt])

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Text bold color="cyan">supertinker</Text>
      <Text dimColor>{state.workflowId || "..."}</Text>
      <Text>{state.runId.slice(0, 30) || "..."}</Text>
      <Text bold>{elapsed}</Text>
    </Box>
  )
}

function formatDisplayEvent(evt: DisplayEvent): string {
  switch (evt.t) {
    case "thinking": return `  ${evt.text.slice(0, 120)}...`
    case "text": return evt.text.split("\n")[0].slice(0, 200)
    case "tool_start": {
      const argStr = Object.entries(evt.args).map(([k, v]) => `${k}=${v}`).join(" ").slice(0, 80)
      return `[${evt.name}] ${argStr}`
    }
    case "tool_end": return `  -> ${evt.result.slice(0, 120)}`
    case "subagent_start": return `>> ${evt.name}: ${evt.desc.slice(0, 80)}`
    case "subagent_end": return `<< ${evt.id} (${evt.tools} tools, ${Math.round(evt.duration_ms / 1000)}s)`
    case "error": return `ERROR: ${evt.text.slice(0, 120)}`
    case "start": return `Starting ${evt.provider}${evt.model ? ` (${evt.model})` : ""} in ${evt.cwd}`
    case "end": return "Agent finished"
  }
}

function AgentPanel({
  agent,
  runDir,
  loadMapper,
}: {
  agent: AgentState
  runDir: string
  loadMapper: (provider: string) => Promise<TranscriptMapper | null>
}) {
  const displayEvents = useTranscriptStream(agent.metaPath, loadMapper)
  const fallbackLines = useFileTail(agent.logFile, 30)
  const [elapsed, setElapsed] = useState("")
  const { stdout } = useStdout()
  const panelHeight = Math.max(5, Math.floor(((stdout?.rows ?? 24) - 10) / Math.max(1, 1)))

  useEffect(() => {
    const interval = setInterval(() => {
      const ms = Date.now() - agent.startedAt
      const s = Math.floor(ms / 1000) % 60
      const m = Math.floor(ms / 60000) % 60
      setElapsed(`${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`)
    }, 1000)
    return () => clearInterval(interval)
  }, [agent.startedAt])

  const hasStructured = displayEvents.length > 0
  const linesToShow = hasStructured
    ? displayEvents.slice(-panelHeight).map(formatDisplayEvent)
    : fallbackLines.slice(-panelHeight)

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      <Box justifyContent="space-between">
        <Text bold color="green">
          <Spinner type="dots" /> {agent.agent}
        </Text>
        <Text dimColor>{agent.provider}</Text>
        <Text dimColor>{elapsed}</Text>
      </Box>
      {linesToShow.map((line, i) => (
        <Text key={i} wrap="truncate">{line}</Text>
      ))}
    </Box>
  )
}

function AgentPanelStack({
  agents,
  runDir,
  loadMapper,
}: {
  agents: Map<string, AgentState>
  runDir: string
  loadMapper: (provider: string) => Promise<TranscriptMapper | null>
}) {
  const entries = Array.from(agents.values())
  if (entries.length === 0) {
    return (
      <Box paddingX={1} paddingY={1}>
        <Text dimColor>Waiting for agent...</Text>
      </Box>
    )
  }
  return (
    <Box flexDirection="column" flexGrow={1}>
      {entries.map(agent => (
        <AgentPanel key={agent.nodeId} agent={agent} runDir={runDir} loadMapper={loadMapper} />
      ))}
    </Box>
  )
}

function ControlBar({
  state,
  onPause,
  onResume,
  onQuit,
}: {
  state: PipelineState
  onPause: () => void
  onResume: () => void
  onQuit: () => void
}) {
  useInput((input, key) => {
    if (input === "p" && state.status === "running") onPause()
    if (input === "r" && state.status === "paused") onResume()
    if (input === "q") onQuit()
  })

  const statusColor =
    state.status === "running" ? "green" :
    state.status === "paused" ? "yellow" :
    state.status === "done" ? "cyan" :
    state.status === "failed" ? "red" : "white"

  return (
    <Box borderStyle="single" paddingX={1} justifyContent="space-between">
      <Box gap={2}>
        <Text dimColor={state.status !== "running"}>[p] pause</Text>
        <Text dimColor={state.status !== "paused"}>[r] resume</Text>
        <Text>[q] quit</Text>
      </Box>
      <Text bold color={statusColor}>{state.status.toUpperCase()}</Text>
    </Box>
  )
}

// ─── APP ROOT AND PUBLIC API (Task 9)

interface AppProps {
  runDir: string
  runWorkflow: () => Promise<void>
  resumeWorkflow?: (choice: string) => Promise<void>
  loadMapper: (provider: string) => Promise<TranscriptMapper | null>
}

function App({ runDir, runWorkflow, resumeWorkflow, loadMapper }: AppProps) {
  const { exit } = useApp()
  const events = useEventStream(runDir)
  const state = usePipelineState(events, runDir)
  const [workflowError, setWorkflowError] = useState<string | null>(null)

  useEffect(() => {
    runWorkflow().catch(err => {
      const msg = err instanceof Error ? err.message : String(err)
      if (!msg.includes("failed terminal")) setWorkflowError(msg)
    })
  }, [])

  function handlePause() {
    writeFileSync(join(runDir, "pause-requested"), "")
  }

  function handleResume() {
    // In v1, resume requires restarting via CLI.
  }

  function handleQuit() {
    exit()
    process.exit(0)
  }

  return (
    <Box flexDirection="column" height="100%">
      <Header state={state} />
      <PipelineProgress state={state} />
      {state.error && <Box paddingX={1}><Text color="red">Error: {state.error}</Text></Box>}
      {state.pauseReason && <Box paddingX={1}><Text color="yellow">Paused: {state.pauseReason}</Text></Box>}
      {workflowError && <Box paddingX={1}><Text color="red">Workflow error: {workflowError}</Text></Box>}
      <AgentPanelStack agents={state.activeAgents} runDir={runDir} loadMapper={loadMapper} />
      <ControlBar state={state} onPause={handlePause} onResume={handleResume} onQuit={handleQuit} />
    </Box>
  )
}

export interface DashboardOptions {
  runDir: string
  runWorkflow: () => Promise<void>
  resumeWorkflow?: (choice: string) => Promise<void>
  loadMapper: (provider: string) => Promise<TranscriptMapper | null>
}

export function renderDashboard(opts: DashboardOptions): void {
  render(
    <App
      runDir={opts.runDir}
      runWorkflow={opts.runWorkflow}
      resumeWorkflow={opts.resumeWorkflow}
      loadMapper={opts.loadMapper}
    />,
    { exitOnCtrlC: false },
  )
}
