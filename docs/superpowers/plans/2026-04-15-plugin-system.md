# Plugin System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all non-core extensions into a `plugins/` directory and add a `plugins` CLI command with full lifecycle management (list, install, uninstall, update), keeping `supertinker.ts` unchanged.

**Architecture:** The plugin system is purely a file-management layer in `cli.ts`. Plugins are discovered via `manifest.json` files in `plugins/<type>/<name>/`. Install copies files to `~/.supertinker/` (global) or `.supertinker/` (local). The existing search-path resolution in `supertinker.ts` discovers installed plugins automatically.

**Tech Stack:** TypeScript, Node.js fs/child_process (zero dependencies), raw ANSI terminal UI

---

## File Structure

| File | Role |
|------|------|
| `cli.ts` | Extended with `plugins` subcommand — all plugin logic lives here |
| `plugins/hooks/logger/manifest.json` | Manifest for logger hook |
| `plugins/hooks/logger/logger.ts` | Logger hook (moved from `hooks/logger.ts`) |
| `plugins/hooks/events/manifest.json` | Manifest for events hook |
| `plugins/hooks/events/events.ts` | Events hook (moved from `hooks/events.ts`) |
| `plugins/hooks/fork-worktree/manifest.json` | Manifest for fork-worktree hook |
| `plugins/hooks/fork-worktree/fork-worktree.ts` | Fork-worktree hook (moved from `hooks/fork-worktree.ts`) |
| `plugins/hooks/tmux-panes/manifest.json` | Manifest for tmux-panes hook |
| `plugins/hooks/tmux-panes/tmux-panes.ts` | Tmux-panes hook (moved from `hooks/tmux-panes.ts`) |
| `plugins/hooks/validate-templates/manifest.json` | Manifest for validate-templates hook |
| `plugins/hooks/validate-templates/validate-templates.ts` | Validate-templates hook (moved from `hooks/validate-templates.ts`) |
| `plugins/providers/copilot/manifest.json` | Manifest for copilot provider |
| `plugins/providers/copilot/copilot.ts` | Copilot provider (moved from `providers/copilot.ts`) |
| `plugins/workflows/meta/manifest.json` | Manifest for meta workflow |
| `plugins/workflows/meta/meta.workflow.ts` | Meta workflow (moved from `workflows/meta.workflow.ts`) |
| `plugins/storage/custom/manifest.json` | Manifest for custom storage adapter |
| `plugins/storage/custom/storage.ts` | Custom storage (template copy from `.supertinker/storage/storage.ts`) |
| `skills/supertinker/SKILL.md` | Updated with plugins commands and triggers |

---

### Task 1: Create plugin directory structure and manifests

**Files:**
- Create: `plugins/hooks/logger/manifest.json`
- Create: `plugins/hooks/events/manifest.json`
- Create: `plugins/hooks/fork-worktree/manifest.json`
- Create: `plugins/hooks/tmux-panes/manifest.json`
- Create: `plugins/hooks/validate-templates/manifest.json`
- Create: `plugins/providers/copilot/manifest.json`
- Create: `plugins/workflows/meta/manifest.json`
- Create: `plugins/storage/custom/manifest.json`

- [ ] **Step 1: Create logger hook manifest**

```bash
mkdir -p plugins/hooks/logger
```

Write `plugins/hooks/logger/manifest.json`:
```json
{
  "name": "logger",
  "type": "hook",
  "description": "Structured logging to orchestrator.log and stdout for all lifecycle events",
  "files": ["logger.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 2: Create events hook manifest**

```bash
mkdir -p plugins/hooks/events
```

Write `plugins/hooks/events/manifest.json`:
```json
{
  "name": "events",
  "type": "hook",
  "description": "NDJSON event stream — writes machine-readable JSON lines to events.ndjson",
  "files": ["events.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 3: Create fork-worktree hook manifest**

```bash
mkdir -p plugins/hooks/fork-worktree
```

Write `plugins/hooks/fork-worktree/manifest.json`:
```json
{
  "name": "fork-worktree",
  "type": "hook",
  "description": "Isolates fork branches in git worktrees — parallel agents work in separate repo copies",
  "files": ["fork-worktree.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 4: Create tmux-panes hook manifest**

```bash
mkdir -p plugins/hooks/tmux-panes
```

Write `plugins/hooks/tmux-panes/manifest.json`:
```json
{
  "name": "tmux-panes",
  "type": "hook",
  "description": "Opens tmux panes for orchestrator log and per-agent log tailing",
  "files": ["tmux-panes.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 5: Create validate-templates hook manifest**

```bash
mkdir -p plugins/hooks/validate-templates
```

Write `plugins/hooks/validate-templates/manifest.json`:
```json
{
  "name": "validate-templates",
  "type": "hook",
  "description": "Aborts run if workflow instructions reference undefined template variables",
  "files": ["validate-templates.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 6: Create copilot provider manifest**

```bash
mkdir -p plugins/providers/copilot
```

Write `plugins/providers/copilot/manifest.json`:
```json
{
  "name": "copilot",
  "type": "provider",
  "description": "GitHub Copilot CLI provider with sentinel-based choice parsing",
  "files": ["copilot.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 7: Create meta workflow manifest**

```bash
mkdir -p plugins/workflows/meta
```

Write `plugins/workflows/meta/manifest.json`:
```json
{
  "name": "meta",
  "type": "workflow",
  "description": "Architect agent designs a workflow, then the orchestrator executes it",
  "files": ["meta.workflow.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 8: Create custom storage manifest**

```bash
mkdir -p plugins/storage/custom
```

Write `plugins/storage/custom/manifest.json`:
```json
{
  "name": "custom",
  "type": "storage",
  "description": "Project-local workflow persistence — saves generated workflows to .supertinker/workflows/",
  "files": ["storage.ts"],
  "version": "1.0.0"
}
```

- [ ] **Step 9: Commit**

```bash
git add plugins/
git commit -m "feat: create plugin manifest files for all extensions"
```

---

### Task 2: Move extension files into plugins directory

**Files:**
- Move: `hooks/logger.ts` → `plugins/hooks/logger/logger.ts`
- Move: `hooks/events.ts` → `plugins/hooks/events/events.ts`
- Move: `hooks/fork-worktree.ts` → `plugins/hooks/fork-worktree/fork-worktree.ts`
- Move: `hooks/tmux-panes.ts` → `plugins/hooks/tmux-panes/tmux-panes.ts`
- Move: `hooks/validate-templates.ts` → `plugins/hooks/validate-templates/validate-templates.ts`
- Move: `providers/copilot.ts` → `plugins/providers/copilot/copilot.ts`
- Move: `workflows/meta.workflow.ts` → `plugins/workflows/meta/meta.workflow.ts`
- Copy: `.supertinker/storage/storage.ts` → `plugins/storage/custom/storage.ts`

- [ ] **Step 1: Move all hook files**

```bash
mv hooks/logger.ts plugins/hooks/logger/logger.ts
mv hooks/events.ts plugins/hooks/events/events.ts
mv hooks/fork-worktree.ts plugins/hooks/fork-worktree/fork-worktree.ts
mv hooks/tmux-panes.ts plugins/hooks/tmux-panes/tmux-panes.ts
mv hooks/validate-templates.ts plugins/hooks/validate-templates/validate-templates.ts
```

- [ ] **Step 2: Fix import paths in moved hook files**

All hooks import from `"../supertinker.js"`. After moving into `plugins/hooks/<name>/`, the relative path needs updating.

In each of the 5 hook files, change:
```typescript
// OLD
import type { Hook, HookEvent, HookDirective } from "../supertinker.js"
// NEW
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"
```

For `fork-worktree.ts` which also imports `Context`:
```typescript
// OLD
import type { Hook, HookEvent, HookDirective, Context } from "../supertinker.js"
// NEW
import type { Hook, HookEvent, HookDirective, Context } from "../../../supertinker.js"
```

- [ ] **Step 3: Move copilot provider**

```bash
mv providers/copilot.ts plugins/providers/copilot/copilot.ts
```

No import path fix needed — `copilot.ts` doesn't import from supertinker.

- [ ] **Step 4: Move meta workflow**

```bash
mv workflows/meta.workflow.ts plugins/workflows/meta/meta.workflow.ts
```

Fix import path in `meta.workflow.ts`:
```typescript
// OLD
import type { Workflow } from "../supertinker"
// NEW
import type { Workflow } from "../../../supertinker"
```

- [ ] **Step 5: Copy storage template**

```bash
cp .supertinker/storage/storage.ts plugins/storage/custom/storage.ts
```

Fix import path in `plugins/storage/custom/storage.ts`:
```typescript
// OLD
import type { StorageAdapter } from "../../supertinker.js"
// NEW
import type { StorageAdapter } from "../../../supertinker.js"
```

The original `.supertinker/storage/storage.ts` stays unchanged (project-local usage).

- [ ] **Step 6: Delete empty root directories**

```bash
rmdir hooks
rmdir workflows
```

The `providers/` directory stays — it still contains `claude.ts`.

- [ ] **Step 7: Verify no broken imports remain**

```bash
grep -r 'from "\.\./' plugins/ --include='*.ts'
```

Expected: all imports should be `from "../../../supertinker.js"` or `from "../../../supertinker"`.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor: move extensions from root into plugins/ directory"
```

---

### Task 3: Fix example workflow import path

**Files:**
- Modify: `examples/workflow.ts:1`

- [ ] **Step 1: Check the import in examples/workflow.ts**

The example file currently has:
```typescript
import type { Workflow, GuardrailCheck } from "../supertinker"
```

This import references `supertinker` at the repo root, which is unchanged. Verify this still works — it should, since `supertinker.ts` hasn't moved. No change needed if the relative path from `examples/` to `supertinker.ts` is still `../supertinker`.

```bash
ls -la examples/workflow.ts supertinker.ts
```

If the file resolves correctly, no change. Move on.

- [ ] **Step 2: Commit (only if changes were made)**

```bash
git status
# If clean, skip. If changes, commit:
git add examples/
git commit -m "fix: update example workflow import path after restructure"
```

---

### Task 4: Implement manifest reading utilities in cli.ts

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add manifest types and constants at top of cli.ts**

After the existing imports in `cli.ts`, add:

```typescript
import { copyFileSync, unlinkSync } from "fs"
import { execSync } from "child_process"
import { homedir } from "os"

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
const REPO_URL = "https://github.com/gpavanello/supertinker.git"  // configurable default
```

- [ ] **Step 2: Implement discoverPlugins function**

Add below the constants:

```typescript
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
```

- [ ] **Step 3: Implement loadInstalled and saveInstalled functions**

```typescript
function loadInstalled(targetDir: string): InstalledJson {
  const p = join(targetDir, "installed.json")
  if (!existsSync(p)) return { plugins: [] }
  try { return JSON.parse(readFileSync(p, "utf8")) } catch { return { plugins: [] } }
}

function saveInstalled(targetDir: string, data: InstalledJson): void {
  writeFileSync(join(targetDir, "installed.json"), JSON.stringify(data, null, 2))
}
```

- [ ] **Step 4: Implement ensureCache function**

```typescript
function ensureCache(): string {
  if (existsSync(join(CACHE_DIR, "plugins"))) return CACHE_DIR
  if (existsSync(CACHE_DIR)) return CACHE_DIR  // exists but maybe no plugins yet
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
```

- [ ] **Step 5: Commit**

```bash
git add cli.ts
git commit -m "feat: add plugin manifest reading utilities to cli.ts"
```

---

### Task 5: Implement `plugins list` command

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add the pluginsList function**

```typescript
function pluginsList(onlyInstalled: boolean): void {
  const cacheRoot = ensureCache()
  const available = discoverPlugins(join(cacheRoot, "plugins"))

  const globalInstalled = loadInstalled(USER_HOME)
  const localInstalled = loadInstalled(join(process.cwd(), ".supertinker"))
  const installedMap = new Map<string, string>()  // name → "global" | "local"
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
```

- [ ] **Step 2: Wire the list command into the CLI**

In the `cli()` function, add a new branch before the help text at the bottom:

```typescript
  if (cmd === "plugins") {
    const sub = argv[1]
    if (sub === "list") {
      pluginsList(argv.includes("--installed"))
      return
    }
    // other subcommands will be added in later tasks
    console.log(`Usage: supertinker plugins <list|install|uninstall|update>`)
    return
  }
```

- [ ] **Step 3: Test manually**

```bash
tsx cli.ts plugins list
```

Expected: shows all plugins grouped by type with `○` (not installed) markers.

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: implement 'plugins list' CLI command"
```

---

### Task 6: Implement ANSI interactive picker

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add the ANSI picker function**

This is the most code-heavy part. Add the following function:

```typescript
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

    // Build flat list with headers
    const items: PickerItem[] = []
    for (const type of PLUGIN_TYPES) {
      const plugins = available.filter(p => p.type === type)
      if (plugins.length === 0) continue
      items.push({ name: typeLabels[type], description: "", type, selected: false, isHeader: true })
      for (const p of plugins) {
        items.push({ name: p.name, description: p.description, type: p.type, selected: false, isHeader: false })
      }
    }

    let cursor = items.findIndex(i => !i.isHeader)  // first selectable
    if (cursor < 0) { resolve([]); return }

    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")

    function render(): void {
      // Move cursor to top and clear
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
      if (key === "\x1b[A") {  // up
        do { cursor = (cursor - 1 + items.length) % items.length } while (items[cursor].isHeader)
      } else if (key === "\x1b[B") {  // down
        do { cursor = (cursor + 1) % items.length } while (items[cursor].isHeader)
      } else if (key === " ") {  // space
        const item = items[cursor]
        if (!item.isHeader && !alreadyInstalled.has(item.name)) {
          item.selected = !item.selected
        }
      } else if (key === "\r" || key === "\n") {  // enter
        stdin.setRawMode(wasRaw ?? false)
        stdin.removeListener("data", onKey)
        stdin.pause()
        process.stdout.write("\x1b[H\x1b[J")  // clear
        resolve(items.filter(i => i.selected && !i.isHeader).map(i => i.name))
        return
      } else if (key === "\x03") {  // ctrl-c
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
```

- [ ] **Step 2: Add the scope picker (global/local)**

```typescript
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
```

- [ ] **Step 3: Test the picker in isolation**

```bash
tsx -e "
import { stdin } from 'process';
console.log('stdin.isTTY:', stdin.isTTY);
console.log('stdin.setRawMode available:', typeof stdin.setRawMode);
"
```

Expected: `stdin.isTTY: true` and `setRawMode available: function` (when run in a terminal).

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: implement ANSI interactive picker for plugin selection"
```

---

### Task 7: Implement `plugins install` command

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add installPlugins function**

```typescript
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
    // Interactive picker
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
      copyFileSync(join(sourceDir, file), join(destDir, file))
    }

    installed.plugins.push({
      name: manifest.name,
      type: manifest.type,
      version: manifest.version,
      installedAt: new Date().toISOString(),
    })

    console.log(`  installed: ${name} (${manifest.type}) → ${scope}`)
    count++
  }

  saveInstalled(targetDir, installed)
  console.log(`\n${count} plugin(s) installed.`)
}
```

- [ ] **Step 2: Wire the install command into the CLI**

In the `plugins` command branch in `cli()`, add:

```typescript
    if (sub === "install") {
      const names = argv.slice(2).filter(a => !a.startsWith("--"))
      let scope: "global" | "local" | undefined
      if (argv.includes("--global")) scope = "global"
      if (argv.includes("--local")) scope = "local"
      if (!scope) scope = await ansiScopePicker()
      await installPlugins(names, scope)
      return
    }
```

- [ ] **Step 3: Test named install**

```bash
tsx cli.ts plugins install logger --global
tsx cli.ts plugins list
```

Expected: logger shows as `● logger ... [global]`.

Verify file was copied:
```bash
ls ~/.supertinker/hooks/logger.ts
```

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: implement 'plugins install' CLI command with interactive picker"
```

---

### Task 8: Implement `plugins uninstall` command

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add uninstallPlugins function**

```typescript
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

    // Read manifest from cache to know which files to remove
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
```

- [ ] **Step 2: Wire the uninstall command**

In the `plugins` command branch:

```typescript
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
```

- [ ] **Step 3: Test uninstall**

```bash
tsx cli.ts plugins uninstall logger --global
tsx cli.ts plugins list
ls ~/.supertinker/hooks/logger.ts  # should not exist
```

Expected: logger shows as `○` (not installed), file removed.

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: implement 'plugins uninstall' CLI command"
```

---

### Task 9: Implement `plugins update` command

**Files:**
- Modify: `cli.ts`

- [ ] **Step 1: Add pluginsUpdate function**

```typescript
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

  // Update global
  const globalInstalled = loadInstalled(USER_HOME)
  for (const entry of globalInstalled.plugins) {
    const manifest = availableMap.get(entry.name)
    if (!manifest) continue
    const sourceDir = join(CACHE_DIR, "plugins", TYPE_TO_DIR[manifest.type], manifest.name)
    const destDir = join(USER_HOME, TYPE_TO_DIR[manifest.type])
    mkdirSync(destDir, { recursive: true })
    for (const file of manifest.files) {
      copyFileSync(join(sourceDir, file), join(destDir, file))
    }
    const changed = entry.version !== manifest.version
    if (changed) {
      console.log(`  updated: ${entry.name} (${entry.version} → ${manifest.version}) [global]`)
      entry.version = manifest.version
      updated++
    } else {
      console.log(`  current: ${entry.name} (${entry.version}) [global]`)
    }
  }
  saveInstalled(USER_HOME, globalInstalled)

  // Update local
  const localDir = join(process.cwd(), ".supertinker")
  const localInstalled = loadInstalled(localDir)
  for (const entry of localInstalled.plugins) {
    const manifest = availableMap.get(entry.name)
    if (!manifest) continue
    const sourceDir = join(CACHE_DIR, "plugins", TYPE_TO_DIR[manifest.type], manifest.name)
    const destDir = join(localDir, TYPE_TO_DIR[manifest.type])
    mkdirSync(destDir, { recursive: true })
    for (const file of manifest.files) {
      copyFileSync(join(sourceDir, file), join(destDir, file))
    }
    const changed = entry.version !== manifest.version
    if (changed) {
      console.log(`  updated: ${entry.name} (${entry.version} → ${manifest.version}) [local]`)
      entry.version = manifest.version
      updated++
    } else {
      console.log(`  current: ${entry.name} (${entry.version}) [local]`)
    }
  }
  saveInstalled(localDir, localInstalled)

  console.log(`\n${updated} plugin(s) updated.`)
}
```

- [ ] **Step 2: Wire the update command**

In the `plugins` command branch:

```typescript
    if (sub === "update") {
      pluginsUpdate()
      return
    }
```

- [ ] **Step 3: Test update flow**

```bash
# Install a plugin first
tsx cli.ts plugins install logger --global
# Then update
tsx cli.ts plugins update
```

Expected: reports `current: logger (1.0.0) [global]` (no version change since we just installed).

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: implement 'plugins update' CLI command"
```

---

### Task 10: Update CLI help text and entrypoint

**Files:**
- Modify: `cli.ts:142-163`

- [ ] **Step 1: Update the help text**

Replace the existing help text block in `cli()`:

```typescript
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
```

- [ ] **Step 2: Update the entrypoint to handle `plugins` command**

At the bottom of `cli.ts`, update the entrypoint:

```typescript
const cmd = process.argv[2]
if (!cmd || cmd === "list" || cmd === "status" || cmd === "help" || cmd === "plugins") cli().catch(err => { console.error(err); process.exit(1) })
else if (ensureTmux()) cli().catch(err => { console.error(err); process.exit(1) })
```

The `plugins` command should not launch tmux — it's a management command, not a workflow runner.

- [ ] **Step 3: Test help output**

```bash
tsx cli.ts help
```

Expected: updated help text including plugins commands.

- [ ] **Step 4: Commit**

```bash
git add cli.ts
git commit -m "feat: update CLI help text and entrypoint for plugins command"
```

---

### Task 11: Update supertinker skill (SKILL.md)

**Files:**
- Modify: `skills/supertinker/SKILL.md`

- [ ] **Step 1: Update the skill description**

Change line 2 of `skills/supertinker/SKILL.md`:

```markdown
description: Run supertinker agent orchestrator workflows and monitor their execution. Use this skill whenever the user wants to run a multi-agent workflow, orchestrate agents, launch supertinker, check on a supertinker run, resume a paused workflow, or mentions supertinker by name. Also trigger when the user asks to search, install, or manage supertinker plugins, hooks, providers, or workflows.
```

- [ ] **Step 2: Update the "On first run" note**

Change line 7:

```markdown
On first run, install plugins with `$ST plugins install`. The only built-in is the Claude Code provider.
```

- [ ] **Step 3: Add plugins commands to the Commands section**

After the existing commands block (line 22), add:

```markdown
## Plugin Management

```bash
$ST plugins list                                     # show available + installed
$ST plugins list --installed                         # show only installed
$ST plugins install <name> [<name>...] --global      # install by name (global)
$ST plugins install <name> [<name>...] --local       # install by name (project-local)
$ST plugins uninstall <name> [<name>...] --global    # remove plugins
$ST plugins update                                   # pull latest + re-copy installed
```

When the user asks what plugins are available, run `$ST plugins list` and present the results. For installation in a non-interactive context (Claude Code), always use named install with `--global` or `--local` flag — do not attempt the interactive picker.
```

- [ ] **Step 4: Update the "Project-local plugins" section at the bottom**

Replace the existing section:

```markdown
## Plugins

supertinker is extensible through plugins. The only built-in is `providers/claude.ts`. Everything else (hooks, workflows, additional providers, storage adapters) is installable via `$ST plugins install`.

Plugins install to `~/.supertinker/` (global) or `.supertinker/` (project-local). Project-local overrides global. To see what's available: `$ST plugins list`.

Manual overrides still work: drop any `.ts` file into `.supertinker/hooks/`, `.supertinker/providers/`, `.supertinker/workflows/`, or `.supertinker/storage/` in your project.
```

- [ ] **Step 5: Commit**

```bash
git add skills/supertinker/SKILL.md
git commit -m "feat: update supertinker skill with plugins commands and triggers"
```

---

### Task 12: Rebuild skill bundle

**Files:**
- Run: `scripts/build-skill.sh`

- [ ] **Step 1: Rebuild the skill bundle**

The skill has a build script that bundles the skill for distribution:

```bash
bash scripts/build-skill.sh
```

- [ ] **Step 2: Verify the bundle includes updated SKILL.md**

```bash
grep -l "plugins" skills/supertinker/scripts/supertinker.mjs || echo "check SKILL.md was picked up"
cat skills/supertinker/SKILL.md | grep "plugins list"
```

Expected: the SKILL.md contains the plugins commands.

- [ ] **Step 3: Commit the rebuilt bundle**

```bash
git add skills/
git commit -m "build: rebuild skill bundle with plugin system support"
```

---

### Task 13: End-to-end verification

- [ ] **Step 1: Clean state test**

Remove any previously installed plugins to test from scratch:

```bash
rm -f ~/.supertinker/installed.json
rm -f ~/.supertinker/hooks/logger.ts
rm -f ~/.supertinker/hooks/events.ts
```

- [ ] **Step 2: Verify list with nothing installed**

```bash
tsx cli.ts plugins list
```

Expected: all plugins show as `○` (not installed).

- [ ] **Step 3: Verify named install**

```bash
tsx cli.ts plugins install logger events --global
tsx cli.ts plugins list
```

Expected: logger and events show as `● ... [global]`.

- [ ] **Step 4: Verify the installed hooks are discovered by supertinker**

```bash
tsx cli.ts list --hooks
```

Expected: logger and events hooks are listed (discovered from `~/.supertinker/hooks/`).

- [ ] **Step 5: Verify uninstall**

```bash
tsx cli.ts plugins uninstall logger --global
tsx cli.ts plugins list
```

Expected: logger shows as `○`, events still shows as `●`.

- [ ] **Step 6: Verify update**

```bash
tsx cli.ts plugins update
```

Expected: reports `current: events (1.0.0) [global]`.

- [ ] **Step 7: Verify core still works without any plugins**

```bash
tsx cli.ts plugins uninstall events --global
tsx cli.ts list --hooks
```

Expected: "No hooks found." — supertinker runs fine without any plugins.

- [ ] **Step 8: Verify supertinker.ts is unchanged**

```bash
git diff HEAD supertinker.ts
```

Expected: no changes.
