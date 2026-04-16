import { execSync } from "child_process"
import { existsSync, mkdirSync, readdirSync, rmdirSync } from "fs"
import { join, resolve } from "path"
import type { Hook, HookEvent, HookDirective, Context } from "../../../supertinker.js"

/**
 * Fork worktree isolation hook.
 *
 * Creates a git worktree per fork branch so parallel agents work in
 * isolated copies of the repo. On ForkJoin, diffs from each branch
 * are merged back into the main worktree.
 *
 * How it works:
 *   ForkStart  → creates worktrees under .supertinker/worktrees/<runId>/
 *   PreAgent   → injects _worktree context key with the branch's worktree path
 *                (mutable event — writes directly to shared context)
 *   ForkJoin   → merges each branch's changes, removes worktrees
 *
 * Workflow nodes in fork branches should set:
 *   cwd: "[_worktree]"    — or reference context._worktree in their instruction
 *
 * If git is not available or the project is not a git repo, the hook
 * is a no-op (logs a warning and continues).
 */

interface ForkState {
  baseBranch: string
  baseDir: string
  worktreeDir: string
  branches: Map<string, { branch: string; path: string }>  // target nodeId → worktree info
}

// runId:forkNodeId → ForkState
const activeForks = new Map<string, ForkState>()

// nodeId → forkKey — tracks which fork a node belongs to
const nodeToFork = new Map<string, string>()

function git(args: string, cwd: string): string {
  return execSync(`git ${args}`, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim()
}

function isGitRepo(dir: string): boolean {
  try { git("rev-parse --is-inside-work-tree", dir); return true } catch { return false }
}

function getBaseBranch(cwd: string): string {
  try { return git("rev-parse --abbrev-ref HEAD", cwd) } catch { return "main" }
}

function getRepoRoot(cwd: string): string {
  return git("rev-parse --show-toplevel", cwd)
}

export const hook: Hook = {
  name: "fork-worktree",
  description: "Isolates fork branches in git worktrees — parallel agents work in separate repo copies",
  events: ["ForkStart", "PreAgent", "ForkJoin"],
  parallel: false,  // sequential — must run before provider to set context
  priority: 10,     // before logger (0) is too early; after it is fine

  handler: async (event: HookEvent): Promise<HookDirective> => {
    const cwd = process.cwd()

    if (event.event === "ForkStart") {
      const e = event as Extract<HookEvent, { event: "ForkStart" }>

      if (!isGitRepo(cwd)) {
        process.stderr.write(`[fork-worktree] WARN: not a git repo, skipping worktree isolation\n`)
        return { action: "continue" }
      }

      const repoRoot = getRepoRoot(cwd)
      const baseBranch = getBaseBranch(repoRoot)
      const worktreeDir = join(repoRoot, ".supertinker", "worktrees", event.runId.replace(/[/\\]/g, "-"))
      mkdirSync(worktreeDir, { recursive: true })

      const forkKey = `${event.runId}:${e.nodeId}`
      const branches = new Map<string, { branch: string; path: string }>()

      for (const target of e.targets) {
        const branch = `supertinker/${event.runId.replace(/[/\\]/g, "-")}/${target}`
        const wtPath = join(worktreeDir, target)

        try {
          git(`worktree add -b "${branch}" "${wtPath}"`, repoRoot)
          branches.set(target, { branch, path: wtPath })
          nodeToFork.set(target, forkKey)
          process.stderr.write(`[fork-worktree] created worktree: ${target} → ${wtPath}\n`)
        } catch (err) {
          process.stderr.write(`[fork-worktree] WARN: failed to create worktree for ${target}: ${err}\n`)
        }
      }

      activeForks.set(forkKey, {
        baseBranch,
        baseDir: repoRoot,
        worktreeDir,
        branches,
      })

      return { action: "continue" }
    }

    if (event.event === "PreAgent") {
      const e = event as Extract<HookEvent, { event: "PreAgent" }>

      // Inject worktree path for fork branch nodes
      const forkKey = nodeToFork.get(e.nodeId)
      if (forkKey) {
        const fork = activeForks.get(forkKey)
        const branch = fork?.branches.get(e.nodeId)
        if (branch) {
          const ctx = event.context as Context
          ctx[`_worktree:${e.nodeId}`] = branch.path
        }
      }

      // Safety net: if merge errors exist, ensure they're visible in the agent's sliced context.
      // This catches cases where the architect forgot to include _fork_merge_errors in the slice.
      const ctx = event.context as Context
      if (ctx._fork_merge_errors && !nodeToFork.has(e.nodeId)) {
        const existing = ctx[e.nodeId] ?? ""
        if (!existing.includes("MERGE CONFLICT")) {
          ctx[e.nodeId] = `⚠ MERGE CONFLICTS from fork:\n${ctx._fork_merge_errors}\n\n${existing}`
        }
      }

      return { action: "continue" }
    }

    if (event.event === "ForkJoin") {
      const e = event as Extract<HookEvent, { event: "ForkJoin" }>

      // Find the fork state — check all active forks for one whose branches match joinedFrom
      let forkKey: string | undefined
      for (const [key, state] of activeForks) {
        const branchIds = new Set(state.branches.keys())
        if (e.joinedFrom.some(id => branchIds.has(id))) { forkKey = key; break }
      }
      if (!forkKey) return { action: "continue" }

      const fork = activeForks.get(forkKey)!
      const errors: string[] = []

      // Merge each branch's changes back
      for (const [target, { branch, path: wtPath }] of fork.branches) {
        let skipCleanup = false
        try {
          // Check if the branch has any changes
          const diffStat = git(`diff ${fork.baseBranch}...${branch} --stat`, fork.baseDir)
          if (!diffStat) {
            process.stderr.write(`[fork-worktree] ${target}: no changes to merge\n`)
          } else {
            // Merge the branch
            try {
              git(`merge --no-ff -m "merge fork branch: ${target}" ${branch}`, fork.baseDir)
              process.stderr.write(`[fork-worktree] ${target}: merged successfully\n`)
            } catch (mergeErr) {
              // Abort the failed merge and record the error
              try { git("merge --abort", fork.baseDir) } catch {}
              errors.push(`${target}: merge conflict — branch "${branch}" preserved for manual resolution`)
              process.stderr.write(`[fork-worktree] ${target}: merge conflict, branch preserved\n`)
              skipCleanup = true
            }
          }
        } catch (err) {
          errors.push(`${target}: ${err}`)
          process.stderr.write(`[fork-worktree] ${target}: error during merge: ${err}\n`)
          skipCleanup = true
        }

        // Clean up worktree and branch (skip only on merge conflict to allow manual resolution)
        if (!skipCleanup) {
          try {
            git(`worktree remove "${wtPath}" --force`, fork.baseDir)
            git(`branch -D "${branch}"`, fork.baseDir)
          } catch (cleanupErr) {
            process.stderr.write(`[fork-worktree] WARN: cleanup failed for ${target}: ${cleanupErr}\n`)
          }
        }

        nodeToFork.delete(target)
      }

      // Record merge errors in context for downstream nodes
      if (errors.length > 0) {
        const ctx = event.context as Context
        ctx._fork_merge_errors = errors.join("\n")
      }

      // Clean up parent worktree directory if empty
      try {
        const remaining = readdirSync(fork.worktreeDir)
        if (remaining.length === 0) {
          rmdirSync(fork.worktreeDir)
          process.stderr.write(`[fork-worktree] cleaned up worktree dir: ${fork.worktreeDir}\n`)
        }
      } catch {}

      activeForks.delete(forkKey)

      return { action: "continue" }
    }

    return { action: "continue" }
  },
}
