# Core Extraction: Making supertinker.ts Leaner

**Date:** 2026-04-15
**Goal:** Extract non-orchestration concerns from `supertinker.ts` into existing plugin patterns, shrinking the core to types + context + hooks + guardrails + providers + `executeNode`/`run`/`resume`.

## Approach

Incremental, easiest-first (Approach B). Each step is independently testable with a real `supertinker run`.

## Step 1: Tmux → Hook

**What moves:** `tmuxRunning()`, `tmux()`, and three inline call sites (two in `invokeAgent`, one in `run`).

**Where:** New `hooks/tmux-panes.ts`.

**Events:**
- `RunStart` — open tmux pane tailing `orchestrator.log`
- `PreProvider` — open tmux pane tailing `join(event.runDir, \`${nodeId}.log\`)` (hook computes log path from event payload, no core payload change needed)
- `PostAgent` — close the node's tmux pane after 800ms delay

**Hook internals:** Checks `process.env.TMUX` before spawning. Uses `spawn("tmux", ...)` with `{ detached: true, stdio: "ignore" }` and `.unref()` — same as today's inline code.

**Priority:** Default (50). Parallel: true.

**Core change:** Delete `tmuxRunning()`, `tmux()`, and the three call sites. Zero API change.

## Step 2: Template Validation → Hook

**What moves:** `validateTemplateVariables()` and its call site in `run()`.

**Where:** New `hooks/validate-templates.ts`.

**Events:**
- `RunStart` — receives `workflow` (with `.graph`) and `initialContext` in payload

**Logic:** Iterate `workflow.graph.nodes`, match `[varName]` patterns in instructions, verify each is a node ID or `initialContext` key. On unresolved variables, return `{ action: "abort", reason: "..." }` with the existing error message format.

**Priority:** 0 (highest), `parallel: false` — runs sequentially before any other `RunStart` hook so misconfigured workflows are caught immediately.

**Core change:** Delete `validateTemplateVariables()` and its call in `run()`. Zero API change.

## Step 3: Workflow Catalog → Storage Adapter

**What moves:** `buildCatalog()`, `resolveWorkflow()`, `catalogMtimeKey()`, `catalogCache`.

**Where:** Two new methods on `StorageAdapter` interface, implemented in `filesystemStorage`.

**New interface methods:**
```ts
resolveWorkflow(name: string): Promise<string | null>
listWorkflows(): Promise<Array<{ id: string; description: string; file: string; source: string }>>
```

**`filesystemStorage` implementation:** Same logic as today's functions — scan `PROJECT_DIR → USER_DIR → BUILTIN_DIR` for `.workflow.ts` files. The mtime cache moves into the filesystem implementation as a private detail.

**`buildCatalog()`** becomes a thin exported utility in core that calls `storage.listWorkflows()` and formats the result string. This keeps the catalog string available for injection into `initialContext.catalog` by any consumer (CLI, skill, etc.) without putting formatting logic on the storage adapter.

**Core change:** +2 methods on `StorageAdapter` interface. Delete `resolveWorkflow()`, `catalogMtimeKey()`, `catalogCache`, and most of `buildCatalog()` body (replaced by delegation to storage).

## Step 4: CLI → `cli.ts`

**What moves:** `cli()`, `ensureTmux()`, and the `isMain` entrypoint block (~80 lines).

**Where:** New `cli.ts` at project root.

**`cli.ts` structure:**
- `#!/usr/bin/env tsx` shebang
- Imports from `supertinker.ts`: `run`, `resume`, `buildCatalog`, `loadStorage`, types
- Contains `ensureTmux()` — tmux auto-launch is CLI UX, not orchestration
- Contains `cli()` with all subcommand handling: `run`, `resume`, `status`, `list`, `help`
- `status` command uses storage adapter methods (`loadContext`, `loadPause`, `pauseExists`) where available, reads log file directly for display

**`supertinker.ts` becomes a pure library:**
- Exports public API: `run`, `resume`, `buildCatalog`, `loadStorage`, all types
- No longer has a `cli()` function or entrypoint guard
- Not directly executable (no shebang, no `isMain` block)

**Skill bundle:** Unaffected — the skill uses the built artifact which imports `run`/`resume` as library calls.

**Core change:** Delete `cli()`, `ensureTmux()`, `isMain` block. `loadStorage` becomes exported.

## What Stays in Core

After all four extractions, `supertinker.ts` contains:
- Type definitions (all interfaces and types)
- Constants: `BUILTIN_DIR`, `USER_DIR`, `PROJECT_DIR`, `SEARCH_DIRS`
- `filesystemStorage` (default storage adapter, now with `resolveWorkflow`/`listWorkflows`)
- `findFile()`, `loadProvider()`, `loadStorage()`, `loadHooks()`
- Context utilities: `sliceContext()`, `renderUserPrompt()`, `resolveFallback()`, `saveContext()`
- `buildSystemPrompt()`
- `buildCatalog()` (thin wrapper over `storage.listWorkflows()`)
- Hook system: `emitHook()`, `bootstrapLog()`, validation constants
- Guardrails: `evalGuardrail()`, `runGuardrails()`
- Orchestration: `invokeAgent()`, `executeNode()`, `errorFallback()`, `applyDirective()`, `writePause()`
- Public API: `run()`, `resume()`

**Estimated reduction:** ~190 lines removed, ~10 lines added. Core shrinks ~35%.

## Risks and Mitigations

**Risk:** Tmux hook timing differs from inline calls.
**Mitigation:** The hook receives the same event data. `PreProvider` fires at exactly the same point as the old inline `tmux()` call in `invokeAgent`. Test with a real multi-node workflow.

**Risk:** Template validation hook ordering — other `RunStart` hooks might do work before validation aborts.
**Mitigation:** Priority 0 ensures it runs first. Sequential (`parallel: false`) to guarantee ordering.

**Risk:** `loadStorage()` must be available before CLI can call `storage.resolveWorkflow()`.
**Mitigation:** CLI already needs storage for `status` command. Call `loadStorage()` once at CLI startup.

## Testing

Each step is verified with a real `supertinker run --workflow meta --prompt "..."` before proceeding to the next. Verify:
- Tmux panes still open/close (step 1)
- Bad template variables still abort with clear error (step 2)
- `list` command still shows all workflows from all dirs (step 3)
- All CLI subcommands work from `cli.ts` (step 4)
