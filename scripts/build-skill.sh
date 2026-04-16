#!/usr/bin/env bash
# Bundle supertinker into a single .js file.
#
# The bundle embeds only the claude provider (sole built-in).
# On first run it extracts the built-in to ~/.supertinker/.
# Everything else is installable via `supertinker plugins install`.
#
# Requires: bun (https://bun.sh)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SKILL_DIR="${REPO_ROOT}/skills/supertinker"
ENTRY="$(mktemp /tmp/supertinker-entry-XXXX.ts)"
OUTFILE="${SKILL_DIR}/scripts/supertinker.mjs"
trap "rm -f ${ENTRY} ${REPO_ROOT}/.*.bun-build" EXIT

echo "Bundling supertinker..."
echo "  repo:   ${REPO_ROOT}"
echo "  output: ${OUTFILE}"

# --- Read all built-in files and generate the entry point ---

node -e "
const fs = require('fs');
const path = require('path');

const files = {
  'providers/claude.ts':             fs.readFileSync(path.join('${REPO_ROOT}', 'providers/claude.ts'), 'utf8'),
};

const embedded = JSON.stringify(files);
const stamp = JSON.stringify(new Date().toISOString());

fs.writeFileSync('${ENTRY}', \`#!/usr/bin/env bun
// Auto-generated — do not edit. Run build-skill.sh to regenerate.

import { existsSync, mkdirSync, writeFileSync, readFileSync } from \"fs\"
import { join, resolve } from \"path\"
import { homedir } from \"os\"
import { run, resume, buildCatalog, loadStorage } from \"${REPO_ROOT}/supertinker.ts\"
import type { Context, ProviderOverrides } from \"${REPO_ROOT}/supertinker.ts\"

// ── Embedded built-in files ──
const EMBEDDED: Record<string, string> = \${embedded}
const BUILD_STAMP = \${stamp}

// Extract built-ins to ~/.supertinker/ if missing or stale
const userDir = join(homedir(), \".supertinker\")
const stampFile = join(userDir, \".builtin-stamp\")
const needsExtract = !existsSync(stampFile) || readFileSync(stampFile, \"utf8\").trim() !== BUILD_STAMP

if (needsExtract) {
  for (const [relPath, content] of Object.entries(EMBEDDED)) {
    const abs = join(userDir, relPath)
    mkdirSync(join(abs, \"..\"), { recursive: true })
    writeFileSync(abs, content)
  }
  mkdirSync(userDir, { recursive: true })
  writeFileSync(stampFile, BUILD_STAMP)
}

// ── CLI ──
const argv = process.argv.slice(2)
const cmd = argv[0]
const get = (flag: string) => { const i = argv.indexOf(flag); return i >= 0 ? argv[i + 1] : undefined }

async function main() {
  if (cmd === \"run\") {
    const workflowRef = get(\"--workflow\") ?? \"meta\"
    const prompt = get(\"--prompt\")
    const provider = get(\"--provider\")
    const model = get(\"--model\")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    const storage = await loadStorage()
    const workflowPath = await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef)
    const { workflow } = await import(workflowPath)
    const initialContext: Context = { catalog: await buildCatalog(storage), cwd: process.cwd() }
    if (prompt) initialContext.task = prompt
    await run({ workflow, initialContext, overrides })
    return
  }

  if (cmd === \"resume\") {
    const runId = get(\"--run\"), choice = get(\"--choice\"), workflowRef = get(\"--workflow\")
    const provider = get(\"--provider\"), model = get(\"--model\")
    const overrides: ProviderOverrides = { ...(provider && { provider }), ...(model && { model }) }
    if (!runId || !choice || !workflowRef) {
      console.error(\"Usage: supertinker resume --run <id> --choice <label> --workflow <name|path>\")
      process.exit(1)
    }
    const storage = await loadStorage()
    const { workflow } = await import(await storage.resolveWorkflow(workflowRef) ?? resolve(workflowRef))
    await resume({ workflow, runId, choice, overrides })
    return
  }

  if (cmd === \"list\") {
    const storage = await loadStorage()
    console.log(await buildCatalog(storage))
    return
  }

  if (cmd === \"plugins\") {
    const { execSync } = await import(\"child_process\")
    const cliPath = resolve(\"${REPO_ROOT}\", \"cli.ts\")
    const raw = process.argv.slice(2)
    const escaped = raw.map(function(s: string) { return \"'\" + s.replace(/'/g, \"'\\\\\\\\''\") + \"'\" }).join(\" \")
    // Try bun first (self-contained), fall back to tsx for dev environments
    const runner = (() => { try { require(\"child_process\").execSync(\"which bun\", { stdio: \"ignore\" }); return \"bun\" } catch { return \"tsx\" } })()
    try {
      execSync(runner + \" \" + cliPath + \" \" + escaped, { stdio: \"inherit\", cwd: process.cwd() })
    } catch (e: any) {
      if (e.status) process.exit(e.status)
    }
    return
  }

  console.log(\\\`supertinker — minimal agent orchestrator

Commands:
  run       [--workflow <name|path>] --prompt <text> [--provider <name>] [--model <name>]
  resume    --run <runId> --choice <label> --workflow <name|path>
  list             show available workflows
  plugins list     show available/installed plugins
  plugins install  install plugins
  plugins update   pull latest + re-copy installed

Examples:
  supertinker run --prompt \"Build a REST API\"
  supertinker plugins list
  supertinker plugins install logger fork-worktree --global\\\`)
}

main().catch(err => { console.error(err); process.exit(1) })
\`);

console.log('  generated entry point');
"

# --- Bundle (no --compile, just a single .mjs file) ---
mkdir -p "$(dirname "${OUTFILE}")"
bun build "${ENTRY}" --outfile "${OUTFILE}" --target=node --format=esm

# Make it executable
chmod +x "${OUTFILE}"

SIZE=$(wc -c < "${OUTFILE}" | tr -d ' ')
echo "Done. Bundle at: ${OUTFILE} ($(( SIZE / 1024 ))KB)"
echo "Test: bun ${OUTFILE} list"
