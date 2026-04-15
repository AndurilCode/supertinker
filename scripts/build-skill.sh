#!/usr/bin/env bash
# Bundle supertinker into a single .js file.
#
# The bundle embeds the core engine, built-in providers, hooks, workflows,
# and storage. On first run it extracts built-ins to ~/.supertinker/.
# Project-local plugins (.supertinker/) still override at runtime.
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
  'providers/copilot.ts':            fs.readFileSync(path.join('${REPO_ROOT}', 'providers/copilot.ts'), 'utf8'),
  'hooks/logger.ts':                 fs.readFileSync(path.join('${REPO_ROOT}', 'hooks/logger.ts'), 'utf8'),
  'hooks/tmux-panes.ts':             fs.readFileSync(path.join('${REPO_ROOT}', 'hooks/tmux-panes.ts'), 'utf8'),
  'hooks/validate-templates.ts':     fs.readFileSync(path.join('${REPO_ROOT}', 'hooks/validate-templates.ts'), 'utf8'),
  'workflows/meta.workflow.ts':      fs.readFileSync(path.join('${REPO_ROOT}', 'workflows/meta.workflow.ts'), 'utf8'),
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
    console.log(await buildCatalog())
    return
  }

  console.log(\\\`supertinker — minimal agent orchestrator

Commands:
  run     [--workflow <name|path>] --prompt <text> [--provider <name>] [--model <name>]
  resume  --run <runId> --choice <label> --workflow <name|path> [--provider <name>] [--model <name>]
  list    show available workflows

Options:
  --provider   Override provider for all agents (e.g. copilot, claude)
  --model      Override model for all agents (e.g. opus, gpt-4o)

Examples:
  supertinker run --prompt \"Build a REST API\"
  supertinker run --prompt \"Build a REST API\" --provider copilot --model gpt-4o
  supertinker run --prompt \"Build a REST API\" --model opus
  supertinker list\\\`)
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
