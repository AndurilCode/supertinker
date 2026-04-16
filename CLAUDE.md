# Constitution:
- supertinker.ts must remain a single file, with zero dependencies. 
- It's supposed to be a core that can be extended indefinitely, through hooks, providers, workflows, storage adapters.
- While iterating on this codebase to add new features, the @supertinker.ts must remain unchanged, as soon as it's not strictly necessary (meaning that the supertinker.ts capability to be fully extensible is not yet fulfilled).
- While ideating the solution, firstly rely on the extensions/plugins mechanisms available.

# Context Management

## Subagents (act automatically)

Spawn a subagent whenever intermediate output won't be needed again — only the conclusion returns to parent context. Applies to:

- Throwaway exploration, debugging, or large reads
- Verification against spec (return failures only)
- Research from other codebase areas (read → summarize → implement from summary)
- Docs/tests generation after implementation (from git diff)

## Suggest to user

| Trigger | Suggestion |
|---|---|
| **New unrelated task** | `/clear` + draft first-message brief (goal, constraints, key files, decisions) |
| **Failed approach** | `esc esc` to rewind before failure + draft re-prompt with failure reason and alternative baked in |
| **Context growing large** | `/compact [focus]` before autocompact fires — draft focus directive (active goal, key files, decisions, ruled-out approaches) |
| **Direction change in long session** | Option A: `/compact [focus toward new direction]` — Option B: `/clear` + draft brief for new direction |
| **Next task reuses current context** | Stay in session — state which files/decisions are already loaded and why continuing is cheaper |

**In all suggestions:** always draft the content the user would paste (brief, re-prompt, or compact focus). The user just picks the command and runs it.