# Plugin System Design

**Date**: 2026-04-15
**Status**: Draft

## Overview

Move all non-core extensions (hooks, workflows, providers except claude, storage adapters) out of the supertinker repo root into a `plugins/` directory. Add a `plugins` CLI command with full lifecycle management: list, install, uninstall, update. The core (`supertinker.ts`) remains unchanged — plugins are a file-management layer on top of the existing search-path resolution.

## Goals

- supertinker works out of the box with zero plugins (only `providers/claude.ts` is built-in)
- Users install only what they need via `supertinker plugins install`
- Full lifecycle: list, install, uninstall, update
- Zero new dependencies

## Repo Structure After Migration

```
supertinker/
├── supertinker.ts              # core engine (unchanged)
├── cli.ts                      # CLI (extended with plugins command)
├── providers/
│   └── claude.ts               # sole built-in provider
├── plugins/                    # available plugins (in-repo, not auto-loaded)
│   ├── hooks/
│   │   ├── logger/
│   │   │   ├── logger.ts
│   │   │   └── manifest.json
│   │   ├── events/
│   │   │   ├── events.ts
│   │   │   └── manifest.json
│   │   ├── fork-worktree/
│   │   │   ├── fork-worktree.ts
│   │   │   └── manifest.json
│   │   ├── tmux-panes/
│   │   │   ├── tmux-panes.ts
│   │   │   └── manifest.json
│   │   └── validate-templates/
│   │       ├── validate-templates.ts
│   │       └── manifest.json
│   ├── providers/
│   │   └── copilot/
│   │       ├── copilot.ts
│   │       └── manifest.json
│   ├── workflows/
│   │   └── meta/
│   │       ├── meta.workflow.ts
│   │       └── manifest.json
│   └── storage/
│       └── custom/
│           ├── storage.ts
│           └── manifest.json
├── .supertinker/               # kept (project-local, this repo uses supertinker)
├── examples/
└── docs/
```

### What gets deleted from root

- `hooks/` directory (5 files moved to `plugins/hooks/`)
- `workflows/` directory (1 file moved to `plugins/workflows/`)
- `providers/copilot.ts` (moved to `plugins/providers/copilot/`)

### What stays

- `providers/claude.ts` — sole built-in provider
- `.supertinker/` — project-local usage (this repo uses supertinker itself)
- `supertinker.ts` — untouched
- `cli.ts` — extended with plugins command

## Plugin Manifest Format

Each plugin directory contains a `manifest.json`:

```json
{
  "name": "logger",
  "type": "hook",
  "description": "Structured logging to orchestrator.log and stdout for all lifecycle events",
  "files": ["logger.ts"],
  "version": "1.0.0"
}
```

### Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | yes | Unique identifier, used in `plugins install <name>` |
| `type` | yes | One of: `hook`, `provider`, `workflow`, `storage` |
| `description` | yes | Shown in interactive picker and `plugins list` |
| `files` | yes | List of files to copy (supports multi-file plugins) |
| `version` | yes | Semver string for update detection |

### Install target mapping

| Type | Global target | Local target |
|------|---------------|--------------|
| `hook` | `~/.supertinker/hooks/` | `.supertinker/hooks/` |
| `provider` | `~/.supertinker/providers/` | `.supertinker/providers/` |
| `workflow` | `~/.supertinker/workflows/` | `.supertinker/workflows/` |
| `storage` | `~/.supertinker/storage/` | `.supertinker/storage/` |

Files are copied flat into the target directory (not nested in subdirectories). Example: `plugins/hooks/logger/logger.ts` installs to `~/.supertinker/hooks/logger.ts`.

## CLI Commands

### `supertinker plugins list`

Shows all available plugins grouped by type, with installed status.

```
Hooks:
  ● logger              Structured logging for all lifecycle events        [global]
  ○ events              NDJSON event stream companion
  ○ fork-worktree       Git worktree isolation for parallel branches
  ○ tmux-panes          Auto-spawn tmux window for log tailing
  ○ validate-templates  Guardrail validation helper

Providers:
  ○ copilot             GitHub Copilot CLI provider

Workflows:
  ○ meta                Architect designs + executes workflows

Storage:
  ○ custom              Project-local workflow persistence
```

Flags:
- `--installed` — show only installed plugins

Sources: reads manifests from cache (`~/.supertinker/cache/supertinker/plugins/`), reads `installed.json` from both global and local targets.

### `supertinker plugins install [names...]`

**Named install**: `supertinker plugins install logger fork-worktree --global`

**Interactive install** (no names): launches full ANSI checkbox picker.

```
Select plugins to install (space to toggle, enter to confirm):

  Hooks
  [x] logger            Structured logging for all lifecycle events
  [ ] events            NDJSON event stream companion
  [x] fork-worktree     Git worktree isolation for parallel branches
  [ ] tmux-panes        Auto-spawn tmux window for log tailing
  [ ] validate-templates  Guardrail validation helper

  Providers
  [ ] copilot           GitHub Copilot CLI provider

  Workflows
  [ ] meta              Architect designs + executes workflows

  Storage
  [ ] custom            Project-local workflow persistence
```

Navigation: arrow keys to move, space to toggle, enter to confirm.

If `--global`/`--local` not passed, a second prompt asks:

```
Install to:
  > Global (~/.supertinker/)
    Local (.supertinker/)
```

Already-installed plugins are shown with a note and skipped during copy.

**First run**: if cache doesn't exist, clones the repo first.

### `supertinker plugins uninstall <names...>`

Requires `--global` or `--local` to know where to look. Removes plugin files from the target directory and updates `installed.json`.

### `supertinker plugins update`

1. `git pull` in `~/.supertinker/cache/supertinker/`
2. Re-read manifests from `plugins/` directory in cache
3. For each plugin in global and local `installed.json`, re-copy files
4. Report changes: "Updated 2 plugins: logger (1.0.0 -> 1.1.0), fork-worktree (no changes)"

## Cache and Git Clone Mechanics

### Cache location

`~/.supertinker/cache/supertinker/`

### Clone flow

1. CLI checks if cache directory exists
2. If not: `git clone <repo-url> ~/.supertinker/cache/supertinker/`
3. If exists: no action (use `plugins update` to pull)

### Repo URL

Configurable, defaults to the future GitHub remote URL. For development, the cache can be a local path or symlink — if it exists, clone is skipped.

### Offline behavior

If no cache exists and no network: error with "Plugin cache not found. Run `supertinker plugins update` with network access first."

## Installed Plugins Tracking

Both `~/.supertinker/` and `.supertinker/` can have an `installed.json`:

```json
{
  "plugins": [
    {
      "name": "logger",
      "type": "hook",
      "version": "1.0.0",
      "installedAt": "2026-04-15T10:30:00.000Z"
    }
  ]
}
```

This file is the source of truth for what's installed in that scope. Used by `list` (to show status), `update` (to know what to re-copy), and `uninstall` (to know what to remove).

## Interactive Picker Implementation

Built with raw stdin/stdout and ANSI escape codes to maintain the zero-dependency constraint. No external libraries.

- Raw mode on stdin to capture individual keypresses
- ANSI escape sequences for cursor movement, colors, and clearing
- Arrow keys navigate, space toggles checkboxes, enter confirms
- Groups plugins by type with section headers
- Shows description inline

## Integration with Existing Architecture

**No changes to `supertinker.ts`**. The plugin system is purely a file-management layer. Once a plugin file is copied to the right directory, the existing search-path resolution in `supertinker.ts` discovers it automatically:

- `loadHooks()` scans `hooks/` dirs in `SEARCH_DIRS`
- `loadProvider()` scans `providers/` dirs in `SEARCH_DIRS`
- `listWorkflows()` scans `workflows/` dirs in `SEARCH_DIRS`
- `loadStorage()` scans `storage/` dirs in `SEARCH_DIRS`

The `SEARCH_DIRS` order (`PROJECT_DIR` > `USER_DIR` > `BUILTIN_DIR`) means local plugins override global ones, which override built-in — all of which continues to work unchanged.

## Supertinker Skill Integration

The supertinker skill (`skills/supertinker/SKILL.md`) must be updated to expose the `plugins` command. This allows users to search for and install plugins directly from a Claude Code conversation.

### New skill commands

```bash
$ST plugins list                                    # show available + installed
$ST plugins install <name> [<name>...] --global     # named install
$ST plugins install --local                         # interactive picker
$ST plugins uninstall <name> [<name>...] --global   # remove plugins
$ST plugins update                                  # pull latest + re-copy
```

### Skill behavior for plugin search

When the user asks about available plugins, what hooks exist, or how to extend supertinker, the skill should run `$ST plugins list` and present the results. The skill description in SKILL.md is updated to also trigger on phrases like "search plugins", "install a hook", "what plugins are available", "add copilot provider".

### Updated SKILL.md description

```
description: Run supertinker agent orchestrator workflows and monitor their execution.
Use this skill whenever the user wants to run a multi-agent workflow, orchestrate agents,
launch supertinker, check on a supertinker run, resume a paused workflow, or mentions
supertinker by name. Also trigger when the user asks to search, install, or manage
supertinker plugins, hooks, providers, or workflows.
```

### New section in SKILL.md

A "Plugins" section is added documenting the `plugins` subcommands, so the skill knows how to use them in conversation.

## What Changes

| File | Change |
|------|--------|
| `cli.ts` | Add `plugins` subcommand (list, install, uninstall, update) + ANSI picker |
| `skills/supertinker/SKILL.md` | Add plugins commands, update description trigger |
| `hooks/*` | Move to `plugins/hooks/*/` with manifests |
| `workflows/*` | Move to `plugins/workflows/*/` with manifests |
| `providers/copilot.ts` | Move to `plugins/providers/copilot/` with manifest |
| `.supertinker/storage/storage.ts` | Copy to `plugins/storage/custom/` with manifest |
| `supertinker.ts` | No changes |
