---
name: supertinker
description: Run supertinker agent orchestrator workflows and monitor their execution, and the authoritative authoring reference for every supertinker plugin type. Use this skill whenever the user wants to run a multi-agent workflow, orchestrate agents, launch supertinker, check on a supertinker run, resume a paused workflow, or mentions supertinker by name. Also trigger when the user asks to search, install, manage, build, or create supertinker plugins — workflows, providers, hooks, storage adapters, commands, or custom node types.
---

**Binary**: `bun ${CLAUDE_SKILL_DIR}/scripts/supertinker.mjs` (aliased below as `ST`). Requires `bun` + `tmux`.
On first run, install plugins with `$ST plugins install`. The only built-in is the Claude Code provider.

## Commands

```bash
ST=bun\ ${CLAUDE_SKILL_DIR}/scripts/supertinker.mjs

$ST run --prompt "task"                              # default meta-workflow
$ST run --workflow <name|path> --prompt "task"        # named workflow
$ST run --prompt "task" --provider copilot --model gpt-4o  # override provider/model
$ST run --prompt "task" --model opus                 # override model only
$ST list                                             # available workflows
$ST list --hooks                                     # discovered hooks
$ST status --run <runId>                             # inspect run state
$ST resume --run <runId> --choice <label> --workflow <name>  # resume paused
$ST resume --run <runId> --choice <label> --workflow <name> --provider copilot  # resume with override
$ST --help                                           # all commands incl. installed command plugins
```

Plugins can add custom CLI commands (e.g. `schedule`). Run `$ST --help` to see all available commands including installed command plugins.

## Monitoring

Runs are long-lived (minutes per agent node). Use the `status` command as your primary inspection tool.

### Claude Code — use background + log tail

**Important:** For workflows with fork nodes, the `$ST run` parent process may exit (code 0) while spawned agent processes are still running. Do NOT rely on `run_in_background` task notifications to detect completion. Instead, monitor the orchestrator log for terminal events.

```bash
$ST run --prompt "task" &
```
Then monitor with a log tail (run in background):
```bash
tail -f $(ls -td /tmp/orchestrator/*/ | head -1)/orchestrator.log | grep --line-buffered -E 'START|CHOICE|PAUSED|DONE|FAILED|ERROR'
```

**Completion signals in the log:** `DONE ✓` or `FAILED ✗` mean the run finished. `PAUSED` means human input needed. If you only see `INVOKE` lines, agents are still working — check with `ps aux | grep "session-id"` to confirm.

When the log reports completion or pause, inspect the run:
```bash
$ST status --run <runId>
```

The `status` command shows: run status (PAUSED/completed), pause reason, iteration counts, all context keys with size and preview, and the last 10 log lines. **Use `status` instead of manually reading context.json/state.json.**

If paused, present choices to the user, then `$ST resume`.

Log patterns: `START` (agent began), `INVOKE` (provider spawned), `CHOICE → <label>` (edge followed), `PAUSED` (needs human input — shows resume command), `DONE ✓` / `FAILED ✗` (terminal).

### Run artifacts

Artifacts in `/tmp/orchestrator/<runId>/`:
- `orchestrator.log` — human-readable lifecycle events
- `events.ndjson` — machine-readable event stream (one JSON line per event, includes `duration_ms`, `outputLen`, `promptLen`)
- `context.json` — all node outputs
- `state.json` — pause state + iteration counts (if paused)
- `<nodeId>.log` — raw agent stdout

Query events with `jq`:
```bash
# Agent durations
jq 'select(.event == "PostAgent") | {node: .nodeId, ms: .duration_ms, choice: .choice}' events.ndjson
# Errors only
jq 'select(.event == "Error")' events.ndjson
```

Latest run: `ls -td /tmp/orchestrator/*/ | head -1`

### Other environments — stop and wait

Launch `$ST run --prompt "task"`, tell the user:
> Supertinker running. Check progress: `$ST status --run <runId>`
> Let me know when done or paused.

**Do not poll.** Wait for user to report status, then use `$ST status --run <runId>` to inspect.

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

### Manual plugin install fallback

If `$ST plugins install` fails (e.g. missing runtime dependency), install manually by copying the plugin file to the correct search-path directory:

```bash
# Global install
mkdir -p ~/.supertinker/workflows/  # or hooks/, providers/, storage/
cp plugins/workflows/<name>/<name>.workflow.ts ~/.supertinker/workflows/

# Project-local install
mkdir -p .supertinker/workflows/
cp plugins/workflows/<name>/<name>.workflow.ts .supertinker/workflows/
```

Verify with `$ST list` (workflows) or `$ST list --hooks` (hooks).

## Plugins

supertinker is extensible through plugins. The only built-in is `providers/claude.ts`. Everything else (hooks, workflows, additional providers, storage adapters) is installable via `$ST plugins install`.

Plugins install to `~/.supertinker/` (global) or `.supertinker/` (project-local). Project-local overrides global. To see what's available: `$ST plugins list`.

Manual overrides still work: drop any `.ts` file into `.supertinker/hooks/`, `.supertinker/providers/`, `.supertinker/workflows/`, `.supertinker/storage/`, or `.supertinker/commands/` in your project.

## Building Plugins

All plugin types are TypeScript (or JS) files dropped into a search-path directory — no build step, no registration. When the user wants to **create** or **extend** one, open the matching reference file in `${CLAUDE_SKILL_DIR}/references/`:

| Plugin type | Reference | When to use |
|-------------|-----------|-------------|
| Workflow | `references/workflows.md` | A reusable graph of agent calls — nodes, guardrails, fork/join, subworkflow |
| Provider | `references/providers.md` | Wrap a new agent CLI (the only built-in is `claude`) |
| Hook | `references/hooks.md` | React to lifecycle events; alter flow with `continue`/`skip`/`pause`/`redirect`/`abort` |
| Storage adapter | `references/storage.md` | Customise where run state is persisted (DB, S3, custom FS) |
| Command | `references/commands.md` | Add a CLI subcommand surfaced in `$ST --help` |
| Node type | `references/nodes.md` | Register a new `node.type` primitive (e.g. `script`, `choice`) |

Only read the file for the plugin type you are actually building — they are self-contained.

### Search path (shared by every plugin type)

```
.supertinker/           ← project-local (highest priority)
~/.supertinker/         ← user-global
<supertinker-install>/  ← built-in (lowest priority)
```

Each type has its own subdirectory: `hooks/`, `providers/`, `workflows/`, `storage/`, `commands/`, `nodes/`. Providers/workflows/storage/commands/nodes resolve first match wins; hooks from all three locations merge and all run.

### Plugin manifest (for `$ST plugins install`)

Every plugin shipped via `$ST plugins install` needs a `manifest.json` alongside its implementation:

```json
{
  "name": "my-plugin",
  "type": "hook",
  "description": "What it does",
  "files": ["my-plugin.ts"],
  "version": "1.0.0"
}
```

For manual drop-in plugins (no install command), the manifest is optional.

### Quick reference

| Plugin type | Drop file in | Export | Key constraint |
|-------------|-------------|--------|----------------|
| Workflow | `.supertinker/workflows/` | `export const workflow: Workflow` | filename must be `<id>.workflow.ts` |
| Provider | `.supertinker/providers/` | `export async function invoke(ctx): Promise<AgentResult>` | name must match `command` in registry |
| Hook | `.supertinker/hooks/` | `export const hook: Hook` | all hooks from all paths are merged and run |
| Storage | `.supertinker/storage/` | `export const storage: Partial<StorageAdapter>` | only one storage adapter is active; partial overrides filesystem defaults |
| Command | `.supertinker/commands/` | `export const command: CommandPlugin` | filename is the command name; first match in search path wins |
| Node type | `.supertinker/nodes/` | `export const node: NodeTypeDefinition` | `type` must not shadow a built-in; first match in search path wins |
