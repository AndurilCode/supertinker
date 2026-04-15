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
 *   tsx cli.ts plugins list [--installed]
 *   tsx cli.ts plugins install [<name>...] [--global|--local]
 *   tsx cli.ts plugins uninstall <name>... --global|--local
 *   tsx cli.ts plugins update
 */

import { existsSync, mkdirSync, readFileSync, copyFileSync, unlinkSync, writeFileSync, readdirSync } from "fs"
import { spawnSync, execSync }                        from "child_process"
import { join, resolve }                              from "path"
import { homedir }                                    from "os"
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

// ─── PLUGIN TYPES

interface PluginManifest {
  name: string
  type: "hook" | "provider" | "workflow" | "storage"
  description: string
  files: string[]
  version: string
}

interface InstalledEntry {
  name: string
  type: string
  version: string
  installedAt: string
}

interface InstalledJson {
  plugins: InstalledEntry[]
}

const PLUGIN_TYPES = ["hook", "provider", "workflow", "storage"] as const
const TYPE_TO_DIR: Record<string, string> = {
  hook: "hooks", provider: "providers", workflow: "workflows", storage: "storage",
}

const USER_HOME = join(homedir(), ".supertinker")
const CACHE_DIR = join(USER_HOME, "cache", "supertinker")
const REPO_URL = "https://github.com/gpavanello/supertinker.git"

function discoverPlugins(pluginsRoot: string): PluginManifest[] {
  const manifests: PluginManifest[] = []
  for (const type of PLUGIN_TYPES) {
    const typeDir = join(pluginsRoot, TYPE_TO_DIR[type])
    if (!existsSync(typeDir)) continue
    for (const entry of readdirSync(typeDir)) {
      const manifestPath = join(typeDir, entry, "manifest.json")
      if (!existsSync(manifestPath)) continue
      try {
        const m = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest
        manifests.push(m)
      } catch {}
    }
  }
  return manifests
}

function loadInstalled(targetDir: string): InstalledJson {
  const p = join(targetDir, "installed.json")
  if (!existsSync(p)) return { plugins: [] }
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return { plugins: [] } }
}

function saveInstalled(targetDir: string, data: InstalledJson): void {
  writeFileSync(join(targetDir, "installed.json"), JSON.stringify(data, null, 2))
}

function copyPluginFile(src: string, dest: string): void {
  if (src.endsWith(".ts")) {
    // Rewrite type imports to point at the cached supertinker.ts — always exists
    // at ~/.supertinker/cache/supertinker/ after first plugins command. This gives
    // IDE type-checking in any repo without depending on a local supertinker.ts.
    const cachedSupertinker = join(USER_HOME, "cache", "supertinker", "supertinker.js")
    let content = readFileSync(src, "utf8")
    content = content.replace(
      /from\s+["'][^"']*supertinker(?:\.js)?["']/g,
      `from "${cachedSupertinker}"`,
    )
    writeFileSync(dest, content)
  } else {
    copyFileSync(src, dest)
  }
}

function ensureCache(): string {
  if (existsSync(join(CACHE_DIR, "plugins"))) return CACHE_DIR
  if (existsSync(CACHE_DIR)) return CACHE_DIR
  console.log("Cloning supertinker plugin repository...")
  try {
    mkdirSync(join(USER_HOME, "cache"), { recursive: true })
    execSync(`git clone "${REPO_URL}" "${CACHE_DIR}"`, { stdio: "inherit" })
    return CACHE_DIR
  } catch (err) {
    console.error("Failed to clone plugin repository. Check your network connection.")
    console.error(`  Repo URL: ${REPO_URL}`)
    console.error(`  Cache dir: ${CACHE_DIR}`)
    process.exit(1)
  }
}

// ─── PLUGINS LIST

function pluginsList(onlyInstalled: boolean): void {
  const cacheRoot = ensureCache()
  const available = discoverPlugins(join(cacheRoot, "plugins"))

  const globalInstalled = loadInstalled(USER_HOME)
  const localInstalled = loadInstalled(join(process.cwd(), ".supertinker"))
  const installedMap = new Map<string, string>()
  for (const p of globalInstalled.plugins) installedMap.set(p.name, "global")
  for (const p of localInstalled.plugins) installedMap.set(p.name, "local")

  const grouped = new Map<string, PluginManifest[]>()
  for (const type of PLUGIN_TYPES) grouped.set(type, [])
  for (const m of available) grouped.get(m.type)!.push(m)

  const typeLabels: Record<string, string> = {
    hook: "Hooks", provider: "Providers", workflow: "Workflows", storage: "Storage",
  }

  for (const type of PLUGIN_TYPES) {
    const plugins = grouped.get(type)!
    if (plugins.length === 0) continue
    console.log(`\n${typeLabels[type]}:`)
    for (const p of plugins) {
      const scope = installedMap.get(p.name)
      if (onlyInstalled && !scope) continue
      const marker = scope ? "\u25cf" : "\u25cb"
      const tag = scope ? `  [${scope}]` : ""
      console.log(`  ${marker} ${p.name.padEnd(20)} ${p.description}${tag}`)
    }
  }
  console.log()
}

// ─── ANSI INTERACTIVE PICKER

interface PickerItem {
  name: string
  description: string
  type: string
  selected: boolean
  isHeader: boolean
}

function ansiPicker(available: PluginManifest[], alreadyInstalled: Set<string>): Promise<string[]> {
  return new Promise((resolve) => {
    const typeLabels: Record<string, string> = {
      hook: "Hooks", provider: "Providers", workflow: "Workflows", storage: "Storage",
    }

    const items: PickerItem[] = []
    for (const type of PLUGIN_TYPES) {
      const plugins = available.filter(p => p.type === type)
      if (plugins.length === 0) continue
      items.push({ name: typeLabels[type], description: "", type, selected: false, isHeader: true })
      for (const p of plugins) {
        items.push({ name: p.name, description: p.description, type: p.type, selected: false, isHeader: false })
      }
    }

    let cursor = items.findIndex(i => !i.isHeader)
    if (cursor < 0) { resolve([]); return }

    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    function render(): void {
      process.stdout.write("\x1b[H\x1b[J")
      process.stdout.write("Select plugins to install (\u2191\u2193 navigate, space toggle, enter confirm):\n\n")
      for (let i = 0; i < items.length; i++) {
        const item = items[i]
        if (item.isHeader) {
          process.stdout.write(`  \x1b[1m${item.name}\x1b[0m\n`)
          continue
        }
        const isCursor = i === cursor
        const installed = alreadyInstalled.has(item.name)
        const check = installed ? "\x1b[90m[installed]\x1b[0m" : item.selected ? "[x]" : "[ ]"
        const prefix = isCursor ? "\x1b[36m> \x1b[0m" : "  "
        const nameStr = item.name.padEnd(20)
        process.stdout.write(`${prefix}${check} ${nameStr} ${item.description}\n`)
      }
      process.stdout.write("\n")
    }

    function onKey(key: string): void {
      if (key === "\x1b[A") {
        do { cursor = (cursor - 1 + items.length) % items.length } while (items[cursor].isHeader)
      } else if (key === "\x1b[B") {
        do { cursor = (cursor + 1) % items.length } while (items[cursor].isHeader)
      } else if (key === " ") {
        const item = items[cursor]
        if (!item.isHeader && !alreadyInstalled.has(item.name)) item.selected = !item.selected
      } else if (key === "\r" || key === "\n") {
        stdin.setRawMode(wasRaw ?? false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        process.stdout.write("\x1b[H\x1b[J")
        resolve(items.filter(i => i.selected && !i.isHeader).map(i => i.name))
        return
      } else if (key === "\x03") {
        stdin.setRawMode(wasRaw ?? false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        process.stdout.write("\x1b[H\x1b[J")
        process.exit(0)
      }
      render()
    }

    render()
    stdin.on("data", onKey)
  })
}

function ansiScopePicker(): Promise<"global" | "local"> {
  return new Promise((resolve) => {
    const options = [
      { label: `Global (${USER_HOME}/)`, value: "global" as const },
      { label: `Local (.supertinker/)`, value: "local" as const },
    ]
    let cursor = 0

    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    function render(): void {
      process.stdout.write("\x1b[H\x1b[J")
      process.stdout.write("Install to:\n\n")
      for (let i = 0; i < options.length; i++) {
        const prefix = i === cursor ? "\x1b[36m> \x1b[0m" : "  "
        process.stdout.write(`${prefix}${options[i].label}\n`)
      }
    }

    function onKey(key: string): void {
      if (key === "\x1b[A") cursor = (cursor - 1 + options.length) % options.length
      else if (key === "\x1b[B") cursor = (cursor + 1) % options.length
      else if (key === "\r" || key === "\n") {
        stdin.setRawMode(wasRaw ?? false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        process.stdout.write("\x1b[H\x1b[J")
        resolve(options[cursor].value)
        return
      } else if (key === "\x03") {
        stdin.setRawMode(wasRaw ?? false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        process.stdout.write("\x1b[H\x1b[J")
        process.exit(0)
      }
      render()
    }

    render()
    stdin.on("data", onKey)
  })
}

// ─── PLUGINS INSTALL

async function installPlugins(names: string[], scope: "global" | "local"): Promise<void> {
  const cacheRoot = ensureCache()
  const available = discoverPlugins(join(cacheRoot, "plugins"))
  const targetDir = scope === "global" ? USER_HOME : join(process.cwd(), ".supertinker")
  const installed = loadInstalled(targetDir)
  const installedNames = new Set(installed.plugins.map(p => p.name))

  let toInstall: string[]
  if (names.length > 0) {
    toInstall = names
  } else {
    toInstall = await ansiPicker(available, installedNames)
  }

  if (toInstall.length === 0) {
    console.log("No plugins selected.")
    return
  }

  let count = 0
  for (const name of toInstall) {
    if (installedNames.has(name)) {
      console.log(`  skip: ${name} (already installed)`)
      continue
    }

    const manifest = available.find(m => m.name === name)
    if (!manifest) {
      console.error(`  error: plugin "${name}" not found`)
      continue
    }

    const sourceDir = join(cacheRoot, "plugins", TYPE_TO_DIR[manifest.type], name)
    const destDir = join(targetDir, TYPE_TO_DIR[manifest.type])
    mkdirSync(destDir, { recursive: true })

    for (const file of manifest.files) {
      copyPluginFile(join(sourceDir, file), join(destDir, file))
    }

    installed.plugins.push({
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
      installedAt: new Date().toISOString(),
    })

    console.log(`  installed: ${name} (${manifest.type}) \u2192 ${scope}`)
    count++
  }

  saveInstalled(targetDir, installed)
  console.log(`\n${count} plugin(s) installed.`)
}

// ─── PLUGINS UNINSTALL

function uninstallPlugins(names: string[], scope: "global" | "local"): void {
  const targetDir = scope === "global" ? USER_HOME : join(process.cwd(), ".supertinker")
  const installed = loadInstalled(targetDir)

  let count = 0
  for (const name of names) {
    const idx = installed.plugins.findIndex(p => p.name === name)
    if (idx < 0) {
      console.error(`  skip: ${name} (not installed in ${scope})`)
      continue
    }

    const entry = installed.plugins[idx]
    const dir = join(targetDir, TYPE_TO_DIR[entry.type])

    const cacheRoot = ensureCache()
    const manifestPath = join(cacheRoot, "plugins", TYPE_TO_DIR[entry.type], name, "manifest.json")
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as PluginManifest
      for (const file of manifest.files) {
        const filePath = join(dir, file)
        if (existsSync(filePath)) unlinkSync(filePath)
      }
    }

    installed.plugins.splice(idx, 1)
    console.log(`  uninstalled: ${name} (${entry.type}) from ${scope}`)
    count++
  }

  saveInstalled(targetDir, installed)
  console.log(`\n${count} plugin(s) uninstalled.`)
}

// ─── PLUGINS UPDATE

function pluginsUpdate(): void {
  if (!existsSync(CACHE_DIR)) {
    console.error("Plugin cache not found. Run `supertinker plugins list` first to initialize.")
    process.exit(1)
  }

  console.log("Pulling latest plugins...")
  try {
    execSync("git pull", { cwd: CACHE_DIR, stdio: "inherit" })
  } catch {
    console.error("Failed to pull. Check your network connection.")
    process.exit(1)
  }

  const available = discoverPlugins(join(CACHE_DIR, "plugins"))
  const availableMap = new Map(available.map(m => [m.name, m]))

  let updated = 0

  const globalInstalled = loadInstalled(USER_HOME)
  for (const entry of globalInstalled.plugins) {
    const manifest = availableMap.get(entry.name)
    if (!manifest) continue
    const sourceDir = join(CACHE_DIR, "plugins", TYPE_TO_DIR[manifest.type], manifest.name)
    const destDir = join(USER_HOME, TYPE_TO_DIR[manifest.type])
    mkdirSync(destDir, { recursive: true })
    for (const file of manifest.files) {
      copyPluginFile(join(sourceDir, file), join(destDir, file))
    }
    const changed = entry.version !== manifest.version
    if (changed) {
      console.log(`  updated: ${entry.name} (${entry.version} \u2192 ${manifest.version}) [global]`)
      entry.version = manifest.version
      updated++
    } else {
      console.log(`  current: ${entry.name} (${entry.version}) [global]`)
    }
  }
  saveInstalled(USER_HOME, globalInstalled)

  const localDir = join(process.cwd(), ".supertinker")
  const localInstalled = loadInstalled(localDir)
  for (const entry of localInstalled.plugins) {
    const manifest = availableMap.get(entry.name)
    if (!manifest) continue
    const sourceDir = join(CACHE_DIR, "plugins", TYPE_TO_DIR[manifest.type], manifest.name)
    const destDir = join(localDir, TYPE_TO_DIR[manifest.type])
    mkdirSync(destDir, { recursive: true })
    for (const file of manifest.files) {
      copyPluginFile(join(sourceDir, file), join(destDir, file))
    }
    const changed = entry.version !== manifest.version
    if (changed) {
      console.log(`  updated: ${entry.name} (${entry.version} \u2192 ${manifest.version}) [local]`)
      entry.version = manifest.version
      updated++
    } else {
      console.log(`  current: ${entry.name} (${entry.version}) [local]`)
    }
  }
  saveInstalled(localDir, localInstalled)

  console.log(`\n${updated} plugin(s) updated.`)
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

  if (cmd === "plugins") {
    const sub = argv[1]
    if (sub === "list") {
      pluginsList(argv.includes("--installed"))
      return
    }
    if (sub === "install") {
      const names = argv.slice(2).filter(a => !a.startsWith("--"))
      let scope: "global" | "local" | undefined
      if (argv.includes("--global")) scope = "global"
      if (argv.includes("--local")) scope = "local"
      if (!scope) scope = await ansiScopePicker()
      await installPlugins(names, scope)
      return
    }
    if (sub === "uninstall") {
      const names = argv.slice(2).filter(a => !a.startsWith("--"))
      if (names.length === 0) { console.error("Usage: supertinker plugins uninstall <name> [<name>...] --global|--local"); process.exit(1) }
      let scope: "global" | "local" | undefined
      if (argv.includes("--global")) scope = "global"
      if (argv.includes("--local")) scope = "local"
      if (!scope) { console.error("Specify --global or --local"); process.exit(1) }
      uninstallPlugins(names, scope)
      return
    }
    if (sub === "update") {
      pluginsUpdate()
      return
    }
    console.log("Usage: supertinker plugins <list|install|uninstall|update>")
    return
  }

  console.log(`supertinker — minimal agent orchestrator

Commands:
  run       [--workflow <name|path>] --prompt <text>   (default: meta)
  resume    --run <runId> --choice <label> --workflow <name|path>
  status    --run <runId>   inspect a run's state and context
  list             show available workflows
  list --hooks     show discovered hooks
  plugins list [--installed]          show available/installed plugins
  plugins install [<name>...] [--global|--local]   install plugins
  plugins uninstall <name>... --global|--local     remove plugins
  plugins update                      pull latest + re-copy installed

Examples:
  tsx cli.ts run --prompt "Build a REST API"
  tsx cli.ts plugins list
  tsx cli.ts plugins install logger fork-worktree --global
  tsx cli.ts plugins uninstall logger --global
  tsx cli.ts plugins update`)
}

// ─── ENTRYPOINT

const cmd = process.argv[2]
if (!cmd || cmd === "list" || cmd === "status" || cmd === "help" || cmd === "plugins") cli().catch(err => { console.error(err); process.exit(1) })
else if (ensureTmux()) cli().catch(err => { console.error(err); process.exit(1) })
