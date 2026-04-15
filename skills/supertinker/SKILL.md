---
name: supertinker
description: Run supertinker agent orchestrator workflows and monitor their execution. Use this skill whenever the user wants to run a multi-agent workflow, orchestrate agents, launch supertinker, check on a supertinker run, resume a paused workflow, or mentions supertinker by name. Also trigger when the user asks to run a DAG of agents, compose agent pipelines, or execute a plan-develop-review cycle.
---

**Binary**: `bun ${CLAUDE_SKILL_DIR}/scripts/supertinker.mjs` (aliased below as `ST`). Requires `bun` + `tmux`.
On first run, extracts built-in providers/hooks/workflows to `~/.supertinker/`. Project-local `.supertinker/` overrides built-ins.

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

## Project-local plugins

Override built-ins via `.supertinker/` in cwd: `providers/<name>.ts`, `hooks/<name>.ts`, `workflows/<name>.workflow.ts`, `storage/storage.ts`.
