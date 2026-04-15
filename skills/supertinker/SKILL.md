---
name: supertinker
description: Run supertinker agent orchestrator workflows and monitor their execution. Use this skill whenever the user wants to run a multi-agent workflow, orchestrate agents, launch supertinker, check on a supertinker run, resume a paused workflow, or mentions supertinker by name. Also trigger when the user asks to search, install, or manage supertinker plugins, hooks, providers, or workflows.
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
```

## Monitoring

Runs are long-lived (minutes per agent node). Use the `status` command as your primary inspection tool.

### Claude Code — use Monitor + status

```bash
$ST run --prompt "task" &
```
Then monitor with a log tail:
```
Monitor(command: "tail -f $(ls -td /tmp/orchestrator/*/ | head -1)/orchestrator.log | grep --line-buffered -E 'START|CHOICE|PAUSED|DONE|FAILED|ERROR'")
```

When the monitor reports completion or pause, inspect the run:
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

## Plugins

supertinker is extensible through plugins. The only built-in is `providers/claude.ts`. Everything else (hooks, workflows, additional providers, storage adapters) is installable via `$ST plugins install`.

Plugins install to `~/.supertinker/` (global) or `.supertinker/` (project-local). Project-local overrides global. To see what's available: `$ST plugins list`.

Manual overrides still work: drop any `.ts` file into `.supertinker/hooks/`, `.supertinker/providers/`, `.supertinker/workflows/`, or `.supertinker/storage/` in your project.
