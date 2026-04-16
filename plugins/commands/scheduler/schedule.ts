/**
 * scheduler — command plugin for scheduling supertinker workflows via launchd (macOS)
 *
 * Usage:
 *   supertinker schedule create --workflow <name> --prompt "task" --every <interval>
 *   supertinker schedule create --workflow <name> --prompt "task" --at "09:00"
 *   supertinker schedule create --workflow <name> --prompt "task" --weekday Mon --at "09:00"
 *   supertinker schedule list
 *   supertinker schedule remove <label>
 *   supertinker schedule logs <label>
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from "fs"
import { execSync } from "child_process"
import { join, resolve } from "path"
import { homedir } from "os"
import type { CommandPlugin } from "../../../cli.js"

const SCHEDULES_DIR = join(homedir(), ".supertinker", "schedules")
const LAUNCH_AGENTS = join(homedir(), "Library", "LaunchAgents")
const LABEL_PREFIX  = "com.supertinker.schedule"

interface ScheduleEntry {
  label:    string
  workflow: string
  prompt:   string
  provider?: string
  model?:   string
  every?:   string    // e.g. "5m", "1h", "30s"
  at?:      string    // e.g. "09:00"
  weekday?: string    // e.g. "Mon"
  cwd:      string
  createdAt: string
}

// ── Interval parsing

function parseInterval(s: string): number | null {
  const m = s.match(/^(\d+)(s|m|h)$/)
  if (!m) return null
  const val = parseInt(m[1], 10)
  if (m[2] === "s") return val
  if (m[2] === "m") return val * 60
  if (m[2] === "h") return val * 3600
  return null
}

const WEEKDAY_MAP: Record<string, number> = {
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
  sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6,
}

// ── Plist generation

// Session-specific vars that shouldn't be baked into a scheduled job
const ENV_BLOCKLIST = new Set([
  "TMUX", "TMUX_PANE", "TERM_SESSION_ID", "TERM_PROGRAM_VERSION",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY",
  "SECURITYSESSIONID", "Apple_PubSub_Socket_Render",
  "COMMAND_MODE", "LOGNAME", "LaunchInstanceID",
  "_", "OLDPWD", "PWD", "SHLVL",
])

function captureEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !ENV_BLOCKLIST.has(k)) env[k] = v
  }
  return env
}

function envToPlistBlock(env: Record<string, string>): string {
  const entries = Object.entries(env).map(([k, v]) => {
    const safeKey = k.replace(/[&<>"']/g, "")
    const safeVal = v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    return `        <key>${safeKey}</key>\n        <string>${safeVal}</string>`
  })
  return `    <key>EnvironmentVariables</key>\n    <dict>\n${entries.join("\n")}\n    </dict>`
}

function buildPlist(entry: ScheduleEntry, scriptPath: string, env: Record<string, string>): string {
  let scheduleBlock: string

  if (entry.every) {
    const seconds = parseInterval(entry.every)
    if (!seconds) throw new Error(`Invalid interval: "${entry.every}". Use e.g. 30s, 5m, 1h`)
    scheduleBlock = `    <key>StartInterval</key>\n    <integer>${seconds}</integer>`
  } else if (entry.at) {
    const [hour, minute] = entry.at.split(":").map(Number)
    if (isNaN(hour) || isNaN(minute)) throw new Error(`Invalid time: "${entry.at}". Use HH:MM format`)
    let calEntries = `        <key>Hour</key>\n        <integer>${hour}</integer>\n        <key>Minute</key>\n        <integer>${minute}</integer>`
    if (entry.weekday) {
      const day = WEEKDAY_MAP[entry.weekday.toLowerCase()]
      if (day === undefined) throw new Error(`Invalid weekday: "${entry.weekday}". Use Mon, Tue, etc.`)
      calEntries = `        <key>Weekday</key>\n        <integer>${day}</integer>\n${calEntries}`
    }
    scheduleBlock = `    <key>StartCalendarInterval</key>\n    <dict>\n${calEntries}\n    </dict>`
  } else {
    throw new Error("Specify --every <interval> or --at <HH:MM>")
  }

  const fullLabel = `${LABEL_PREFIX}.${entry.label}`
  const logOut = join(SCHEDULES_DIR, `${entry.label}.log`)
  const logErr = join(SCHEDULES_DIR, `${entry.label}.err`)
  const envBlock = envToPlistBlock(env)

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${fullLabel}</string>

    <key>ProgramArguments</key>
    <array>
        <string>/bin/bash</string>
        <string>${scriptPath}</string>
    </array>

${envBlock}

${scheduleBlock}

    <key>StandardOutPath</key>
    <string>${logOut}</string>

    <key>StandardErrorPath</key>
    <string>${logErr}</string>

    <key>WorkingDirectory</key>
    <string>${entry.cwd}</string>
</dict>
</plist>
`
}

function buildScript(entry: ScheduleEntry): string {
  const stBin = findSTBin()
  const flags = [
    `--workflow ${shellQuote(entry.workflow)}`,
    `--prompt ${shellQuote(entry.prompt)}`,
    "--quiet",
  ]
  if (entry.provider) flags.push(`--provider ${shellQuote(entry.provider)}`)
  if (entry.model)    flags.push(`--model ${shellQuote(entry.model)}`)

  return `#!/bin/bash
# Auto-generated by supertinker schedule — ${entry.label}
# ${entry.createdAt}
set -euo pipefail

cd ${shellQuote(entry.cwd)}
exec ${stBin} run ${flags.join(" ")}
`
}

function whichSync(cmd: string): string | null {
  try { return execSync(`which ${cmd}`, { encoding: "utf8" }).trim() || null }
  catch { return null }
}

function findSTBin(): string {
  // Resolve the runner binary to an absolute path (launchd has minimal PATH)
  const runner = whichSync("bun") ?? whichSync("tsx") ?? whichSync("node")
  if (!runner) throw new Error("Cannot find bun, tsx, or node on PATH")

  // Resolve the CLI entrypoint from the running process
  const entry = process.argv[1]
  if (entry) {
    const resolved = resolve(entry)
    if (existsSync(resolved)) return `${shellQuote(runner)} ${shellQuote(resolved)}`
  }
  // Fallback: check common locations
  const home = homedir()
  const candidates = [
    join(home, ".supertinker", "cache", "supertinker", "bin", "supertinker.mjs"),
    join(home, ".supertinker", "cache", "supertinker", "cli.ts"),
  ]
  for (const c of candidates) {
    if (existsSync(c)) return `${shellQuote(runner)} ${shellQuote(c)}`
  }
  return "supertinker"
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`
}

// ── Subcommands

async function scheduleCreate(args: string[], get: (flag: string) => string | undefined): Promise<void> {
  const workflow = get("--workflow")
  const prompt   = get("--prompt")
  const every    = get("--every")
  const at       = get("--at")
  const weekday  = get("--weekday")
  const provider = get("--provider")
  const model    = get("--model")
  const label    = get("--label") ?? workflow?.replace(/[^a-zA-Z0-9_-]/g, "-") ?? `task-${Date.now()}`

  if (!workflow) { console.error("--workflow is required"); process.exit(1) }
  if (!prompt)   { console.error("--prompt is required"); process.exit(1) }
  if (!every && !at) { console.error("--every <interval> or --at <HH:MM> is required"); process.exit(1) }

  mkdirSync(SCHEDULES_DIR, { recursive: true })
  mkdirSync(LAUNCH_AGENTS, { recursive: true })

  const entry: ScheduleEntry = {
    label, workflow, prompt, provider, model,
    every, at, weekday,
    cwd: process.cwd(),
    createdAt: new Date().toISOString(),
  }

  // Write wrapper script
  const scriptPath = join(SCHEDULES_DIR, `${label}.sh`)
  writeFileSync(scriptPath, buildScript(entry))
  execSync(`chmod +x ${shellQuote(scriptPath)}`)

  // Write plist (snapshot current env so launchd gets API keys, PATH, etc.)
  const env = captureEnv()
  const plistPath = join(LAUNCH_AGENTS, `${LABEL_PREFIX}.${label}.plist`)
  writeFileSync(plistPath, buildPlist(entry, scriptPath, env))

  // Save metadata
  writeFileSync(join(SCHEDULES_DIR, `${label}.json`), JSON.stringify(entry, null, 2))

  // Load into launchd
  try {
    execSync(`launchctl load ${shellQuote(plistPath)}`, { stdio: "pipe" })
  } catch (err) {
    console.error(`Warning: launchctl load failed. You may need to load manually:\n  launchctl load ${plistPath}`)
  }

  const scheduleDesc = every ? `every ${every}` : weekday ? `${weekday} at ${at}` : `daily at ${at}`
  console.log(`\n  Created schedule: ${label}`)
  console.log(`  Workflow:  ${workflow}`)
  console.log(`  Schedule:  ${scheduleDesc}`)
  console.log(`  Script:    ${scriptPath}`)
  console.log(`  Plist:     ${plistPath}`)
  console.log(`  Logs:      ${join(SCHEDULES_DIR, label + ".log")}`)
  console.log()
}

function scheduleList(): void {
  if (!existsSync(SCHEDULES_DIR)) {
    console.log("No scheduled workflows.")
    return
  }

  const files = readdirSync(SCHEDULES_DIR).filter(f => f.endsWith(".json"))
  if (files.length === 0) {
    console.log("No scheduled workflows.")
    return
  }

  console.log(`\nScheduled workflows (${files.length}):\n`)
  for (const file of files) {
    try {
      const entry: ScheduleEntry = JSON.parse(readFileSync(join(SCHEDULES_DIR, file), "utf8"))
      const scheduleDesc = entry.every ? `every ${entry.every}` : entry.weekday ? `${entry.weekday} at ${entry.at}` : `daily at ${entry.at}`

      // Check if loaded in launchd
      let loaded = false
      try {
        execSync(`launchctl list ${LABEL_PREFIX}.${entry.label}`, { stdio: "pipe" })
        loaded = true
      } catch {}

      const status = loaded ? "\x1b[32m●\x1b[0m" : "\x1b[31m○\x1b[0m"
      console.log(`  ${status} ${entry.label.padEnd(24)} ${entry.workflow.padEnd(16)} ${scheduleDesc.padEnd(20)} ${entry.cwd}`)
    } catch {}
  }
  console.log()
}

function scheduleRemove(args: string[]): void {
  const label = args[0]
  if (!label) { console.error("Usage: supertinker schedule remove <label>"); process.exit(1) }

  const plistPath = join(LAUNCH_AGENTS, `${LABEL_PREFIX}.${label}.plist`)

  // Unload from launchd
  if (existsSync(plistPath)) {
    try { execSync(`launchctl unload ${shellQuote(plistPath)}`, { stdio: "pipe" }) } catch {}
    unlinkSync(plistPath)
  }

  // Clean up schedule files
  const metaPath   = join(SCHEDULES_DIR, `${label}.json`)
  const scriptPath = join(SCHEDULES_DIR, `${label}.sh`)
  if (existsSync(metaPath))   unlinkSync(metaPath)
  if (existsSync(scriptPath)) unlinkSync(scriptPath)
  // Keep logs for inspection

  console.log(`  Removed schedule: ${label}`)
  console.log(`  Logs preserved at: ${join(SCHEDULES_DIR, label + ".log")}`)
}

function scheduleLogs(args: string[]): void {
  const label = args[0]
  if (!label) { console.error("Usage: supertinker schedule logs <label>"); process.exit(1) }

  const logPath = join(SCHEDULES_DIR, `${label}.log`)
  const errPath = join(SCHEDULES_DIR, `${label}.err`)

  if (existsSync(logPath)) {
    const lines = readFileSync(logPath, "utf8").trim().split("\n")
    const tail = lines.slice(-30)
    console.log(`\n  stdout (last ${tail.length} of ${lines.length} lines):`)
    for (const line of tail) console.log(`    ${line}`)
  } else {
    console.log(`  No stdout log found at ${logPath}`)
  }

  if (existsSync(errPath)) {
    const content = readFileSync(errPath, "utf8").trim()
    if (content) {
      const lines = content.split("\n").slice(-10)
      console.log(`\n  stderr (last ${lines.length} lines):`)
      for (const line of lines) console.log(`    ${line}`)
    }
  }
  console.log()
}

// ── Export

export const command: CommandPlugin = {
  name: "schedule",
  description: "Schedule supertinker workflows via launchd (macOS)",
  usage: `supertinker schedule <create|list|remove|logs>

  create   --workflow <name> --prompt "task" --every <interval>
  create   --workflow <name> --prompt "task" --at <HH:MM> [--weekday <day>]
  list     show all scheduled workflows
  remove   <label>   unload and remove a schedule
  logs     <label>   tail logs for a schedule

Options for create:
  --workflow <name>      workflow name or path (required)
  --prompt <text>        task prompt (required)
  --every <interval>     run on interval: 30s, 5m, 1h, etc.
  --at <HH:MM>           run at specific time daily
  --weekday <day>        with --at, run only on this weekday (Mon, Tue, etc.)
  --label <name>         custom label (default: workflow name)
  --provider <name>      override provider
  --model <name>         override model`,

  async handler(args, get) {
    const sub = args[0]
    if (sub === "create") return scheduleCreate(args.slice(1), get)
    if (sub === "list")   return scheduleList()
    if (sub === "remove") return scheduleRemove(args.slice(1))
    if (sub === "logs")   return scheduleLogs(args.slice(1))
    console.log(this.usage)
  },
}
