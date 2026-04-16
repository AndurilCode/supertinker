# Interactive Dashboard for supertinker CLI

**Date:** 2026-04-16
**Status:** Draft

## Summary

An Ink-based (React for terminals) live dashboard that replaces the default `run` command output. It tails `events.ndjson` for pipeline progress and per-agent transcript files for streaming agent output, with stacked panels for concurrent agents and keybindings for pause/resume.

## Goals

- Live monitoring of pipeline runs with a Claude Code-inspired streaming experience
- Stacked panels showing concurrent agent output during forks
- Pause/resume controls from the dashboard itself
- Provider-agnostic display via a common display protocol with per-provider transcript mappers

## Non-goals

- Post-run replay/analysis (future enhancement)
- Web-based dashboard
- Changes to `supertinker.ts`

## Architecture

### Approach: Ink-based dashboard module

A new `dashboard.ts` module exports an Ink React app imported by `cli.ts`. The workflow executes in-process as today, but the Ink app replaces raw stdout logging with a structured TUI.

**Data sources:**
1. `events.ndjson` — pipeline-level events (node transitions, forks, joins, pauses, errors)
2. Per-agent transcript files — live agent output, mapped through a common display protocol
3. `{nodeId}.meta.json` — sidecar written by providers linking to transcript file and provider name

### Display Protocol

A common NDJSON schema that all providers can emit, decoupling the dashboard from provider-specific transcript formats.

**Types** (defined in `display-protocol.ts`):

```ts
export type DisplayEvent =
  | { t: "start"; ts: number; provider: string; model?: string; cwd: string }
  | { t: "thinking"; ts: number; text: string }
  | { t: "text"; ts: number; text: string; final: boolean }
  | { t: "tool_start"; ts: number; id: string; name: string; args: Record<string, string> }
  | { t: "tool_end"; ts: number; id: string; name: string; result: string }
  | { t: "subagent_start"; ts: number; id: string; name: string; desc: string }
  | { t: "subagent_end"; ts: number; id: string; tools: number; duration_ms: number }
  | { t: "error"; ts: number; text: string }
  | { t: "end"; ts: number }

export type TranscriptMapper = (line: string) => DisplayEvent | DisplayEvent[] | null
```

**Event types:**

| Type | When emitted | Key fields |
|------|-------------|------------|
| `start` | Provider begins execution | `provider`, `model`, `cwd` |
| `thinking` | Chain-of-thought reasoning | `text` |
| `text` | Assistant prose (streaming or complete) | `text`, `final` |
| `tool_start` | Agent invoked a tool | `id`, `name`, `args` (summarized) |
| `tool_end` | Tool returned | `id`, `name`, `result` (one-line summary) |
| `subagent_start` | Nested agent spawned | `id`, `name`, `desc` |
| `subagent_end` | Nested agent completed | `id`, `tools` (count), `duration_ms` |
| `error` | Something failed | `text` |
| `end` | Agent finished | (empty) |

**Mapper returns:** `DisplayEvent | DisplayEvent[] | null`. A single transcript line may produce multiple display events (e.g., a Claude assistant event containing both text and tool_use blocks), or `null` for lines to skip.

**Args summarization:** `tool_start.args` is a compact summary, not full input. Each mapper truncates large values (file contents in Write, long prompts) to keep display events small.

### Provider Contract Extension

The provider abstraction gains an optional `mapTranscript` export alongside the existing `invoke`:

```ts
// Required (unchanged)
export async function invoke(ctx: ProviderContext): Promise<AgentResult>

// Optional (new)
export function mapTranscript(line: string): DisplayEvent | DisplayEvent[] | null
```

If a provider exports `mapTranscript`, the dashboard uses it to render structured agent output. If not, the dashboard falls back to tailing `{nodeId}.log` as raw text.

### Provider Meta Sidecar

Each provider writes `{nodeId}.meta.json` early in execution:

```json
{"transcriptPath": "~/.claude/projects/abc123.jsonl", "provider": "claude"}
```

The dashboard watches for this file after `PreProvider` event, loads the provider's mapper, and starts tailing the transcript.

### Per-provider mapper behavior

**Claude mapper** (`providers/claude.ts`):
- Reads Claude Code `.jsonl` lines as they stream in real-time
- Maps `thinking` content blocks to `{ t: "thinking" }` events
- Maps `text` content blocks to `{ t: "text" }` events, preserving streaming granularity (`final: false` until `stop_reason` is set)
- Maps `tool_use` content blocks to `{ t: "tool_start" }`, matching `tool_result` user events to `{ t: "tool_end" }`
- Skips `queue-operation`, `attachment`, `system` events (returns `null`)

**Copilot mapper** (`plugins/providers/copilot/copilot.ts`):
- Reads Copilot `events.jsonl` lines in real-time
- Maps `assistant.message` to `{ t: "text", final: true }` (complete text, no streaming)
- Maps `reasoningText` field to `{ t: "thinking" }` when present
- Maps `tool.execution_start` to `{ t: "tool_start" }`, `tool.execution_complete` to `{ t: "tool_end" }`
- Maps `subagent.started` to `{ t: "subagent_start" }`, `subagent.completed` to `{ t: "subagent_end" }`
- Skips `session.start`, `session.info`, `hook.start/end`, `session.shutdown` (returns `null`)

## UI Layout

```
+---------------------------------------------+
| * supertinker  meta-1713284400000   00:03:42 |  <- Header bar
+---------------------------------------------+
| > plan -> > execute [fork] -> architect @    |  <- Pipeline progress
|                             -> implementer @ |
+---------------------------------------------+
| +- architect -------------------- 00:01:22 -+|  <- Agent panel (stacked)
| | Analyzing the codebase structure...       ||
| | [Read] src/api/routes.ts (142 lines)      ||
| | Now implementing the validation layer...  ||
| +-------------------------------------------+|
| +- implementer ------------------ 00:00:48 -+|  <- Agent panel (stacked)
| | Creating src/models/user.ts...            ||
| | [Edit] src/models/user.ts (applied)       ||
| | Writing schema validation...              ||
| +-------------------------------------------+|
+---------------------------------------------+
| [p] pause  [r] resume  [q] quit     RUNNING |  <- Control bar
+---------------------------------------------+
```

**Regions:**

1. **Header bar:** Workflow name, run ID, elapsed timer
2. **Pipeline progress:** Graph nodes as horizontal flow. Completed nodes show checkmark, active nodes show spinner, pending nodes dimmed. Forks show branching lines.
3. **Agent panels:** One per active agent. Appears on `PreAgent` event, removed on `PostAgent`. Each tails the provider's transcript file through `mapTranscript`, auto-scrolling with a ring buffer of ~50 lines. During forks, panels stack vertically and split available terminal height.
4. **Control bar:** Keybindings and current state label (RUNNING / PAUSED / DONE / FAILED).

**Panel behavior:**
- Sequential execution: one panel fills the available space
- Fork: panels split vertically, sharing space equally
- Join: collapses back to one panel
- Terminal too small: auto-degrade to summary lines per agent with up/down to expand one at a time

## Data Flow

### Event stream (`events.ndjson`)

- `fs.watch()` on the file + readline to parse new NDJSON lines as they append
- Each event updates React state: active nodes, completed nodes, fork/join topology, errors, pause state
- Pipeline progress bar is derived entirely from this stream

### Agent transcripts

- On `PreProvider` event: watch for `{nodeId}.meta.json` to appear
- Once meta appears: load provider module, check for `mapTranscript`, start tailing `transcriptPath`
- Tailing uses `fs.watch()` + `fs.read()` with byte offset cursor
- Each line piped through `mapTranscript()`, results pushed to the agent panel's ring buffer (~50 lines)
- On `PostAgent` event: stop tailing, keep final output visible briefly, then remove panel

### Fallbacks

- `{nodeId}.meta.json` doesn't appear within 5s: fall back to tailing `{nodeId}.log` as raw text
- Provider doesn't export `mapTranscript`: tail `{nodeId}.log` as raw text
- File doesn't exist yet: retry on ENOENT until it appears

## CLI Integration

### `run` command

Current behavior (cli.ts:473-485) calls `run()` with hooks writing to stdout. New behavior:

1. `run` launches Ink app (dashboard) immediately
2. Ink app calls `run()` in-process
3. Logger hook still writes to both `orchestrator.log` and stdout — but Ink captures stdout, so logger output doesn't interfere with the TUI. Ink's `<Static>` component or stderr redirect can be used if logger writes cause rendering artifacts. If needed, set `process.env.SUPERTINKER_QUIET_LOGGER=1` before calling `run()` and check it in the logger hook to suppress stdout writes.
4. Dashboard tails `events.ndjson` + transcript files for rendering
5. `--quiet` flag skips dashboard, uses current raw logging behavior (logger writes to stdout as today)

### `resume` command

Same treatment: dashboard renders, then calls `resume()`.

### Tmux

`ensureTmux()` still runs. The Ink app renders inside the tmux session.

### Keybindings

| Key | Action | Available when |
|-----|--------|----------------|
| `p` | Pause (writes pause-requested file) | RUNNING |
| `r` | Resume (shows choice picker, calls `resume()`) | PAUSED |
| `q` | Quit (kills subprocesses, exits cleanly) | Any |
| up/down | Scroll agent panel output | Any |

### User-initiated pause

A new hook plugin `user-pause` checks for a `{runDir}/pause-requested` file on `PreAgent` events and returns `{ action: "pause" }`. The dashboard writes this file when the user presses `p`.

Pause takes effect before the next agent invocation, not mid-agent. In-flight agents complete normally. This is consistent with the existing pause model.

### Resume from dashboard

When PAUSED, pressing `r` shows a choice picker (Ink component) listing available options from `state.json`. User selects one, dashboard calls `resume()` with the chosen label.

## New Files

| File | Purpose |
|------|---------|
| `dashboard.ts` | Ink React app: layout, state, file tailing, keybindings |
| `display-protocol.ts` | TypeScript types for `DisplayEvent` and `TranscriptMapper` |
| `plugins/hooks/user-pause/user-pause.ts` | Hook checking for `pause-requested` file on `PreAgent` |
| `plugins/hooks/user-pause/manifest.json` | Plugin manifest for user-pause hook |

## Changes to Existing Files

| File | Change |
|------|--------|
| `cli.ts` | `run`/`resume` render dashboard by default; `--quiet` for raw mode |
| `providers/claude.ts` | Add `mapTranscript()` export; write `{nodeId}.meta.json` early |
| `plugins/providers/copilot/copilot.ts` | Add `mapTranscript()` export; write `{nodeId}.meta.json` early |

## No Changes To

- `supertinker.ts` (core remains untouched)

## Dependencies

| Package | Purpose |
|---------|---------|
| `ink` | React renderer for terminals |
| `react` | JSX components |
| `ink-spinner` | Spinner for active nodes in pipeline progress |

Added to `package.json` as regular dependencies. Only affects the CLI layer.

## Error Handling

**Events hook not installed:** Dashboard checks at startup via `loadHooks()`. If `events` hook is missing, shows warning and falls back to `--quiet` mode.

**Provider without `mapTranscript`:** Agent panel renders raw text from `{nodeId}.log`.

**Terminal too small for stacked panels:** Auto-degrade from stacked to summary-per-agent with expand/collapse via arrow keys.

**Workflow completes while scrolling:** Dashboard stays up showing final state (DONE/FAILED) until user presses `q`.

**Pause during fork:** Pause-requested file written. Next `PreAgent` in any branch triggers the pause hook. Other in-flight agents complete normally. Pause state captures full context.
