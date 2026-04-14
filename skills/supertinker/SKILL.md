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
$ST list                                             # available workflows
$ST resume --run <runId> --choice <label> --workflow <name>  # resume paused
```

## Monitoring

Runs are long-lived (minutes per agent node). Artifacts in `/tmp/orchestrator/<runId>/`:
- `orchestrator.log` — lifecycle events
- `context.json` — all node outputs
- `state.json` — pause state + choices (if paused)
- `<nodeId>.log` — raw agent stdout

Latest run: `ls -td /tmp/orchestrator/*/ | head -1`

### Claude Code — use Monitor

```bash
$ST run --prompt "task" &
```
Then:
```
Monitor(command: "tail -f $(ls -td /tmp/orchestrator/*/ | head -1)/orchestrator.log")
```

Log patterns: `START` (agent began), `INVOKE` (provider spawned), `CHOICE → <label>` (edge followed), `PAUSED` (needs human input — shows resume command), `DONE ✓` / `FAILED ✗` (terminal).

On complete/pause: read `context.json`. If paused, present choices to user, then `$ST resume`.

### Other environments — stop and wait

Launch `$ST run --prompt "task"`, tell the user:
> Supertinker running. Watch: `tail -f $(ls -td /tmp/orchestrator/*/ | head -1)/orchestrator.log`
> Let me know when done or paused.

**Do not poll.** Wait for user to report status, then read `context.json` / `state.json`.

## Project-local plugins

Override built-ins via `.supertinker/` in cwd: `providers/<name>.ts`, `hooks/<name>.ts`, `workflows/<name>.workflow.ts`, `storage/storage.ts`.
