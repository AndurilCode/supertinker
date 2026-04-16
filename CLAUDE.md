# Constitution:
- supertinker.ts must remain a single file, with zero dependencies. 
- It's supposed to be a core that can be extended indefinitely, through hooks, providers, workflows, storage adapters.
- While iterating on this codebase to add new features, the @supertinker.ts must remain unchanged, as soon as it's not strictly necessary (meaning that the supertinker.ts capability to be fully extensible is not yet fulfilled).
- While ideating the solution, firstly rely on the extensions/plugins mechanisms available.
- Plugins must always be placed in the `plugins/` folder in this project, never directly in `.supertinker/`.

# Context Management

Every turn is a decision point. Manage the context window deliberately — never let it grow by default.

## Subagent Delegation

Spawn a subagent whenever intermediate output will not be needed in parent context. Only the conclusion returns. Mandatory triggers:

- Throwaway exploration, debugging, or large file reads
- Verification against a spec — return failures only
- Reading another codebase area — read → summarize → implement from summary
- Docs or tests generated from the git diff after implementation

Test: *do I need the intermediate work, or just the conclusion?* If only the conclusion → delegate.

## User-Facing Triggers

Surface the suggestion proactively when the trigger fires. Always draft the exact payload — never hand the user a procedure without content ready to paste.

| Trigger | Action |
|---|---|
| **New unrelated task** | Recommend `/clear`. Draft the first-message brief: goal, constraints, key files, decisions to carry over. |
| **Failed approach** | Recommend `esc esc` to rewind before the failure. Draft the re-prompt with failure reason and alternative baked in. |
| **Context approaching ~300k or signs of rot** | Recommend `/compact [focus]` *before* autocompact fires. Draft the focus directive: active goal, key files, decisions, ruled-out approaches. |
| **Direction change mid-session** | Offer both: (A) `/compact [focus toward new direction]` or (B) `/clear` + drafted brief. State the trade-off. |
| **Next task reuses current context** | Recommend staying in session. State which files/decisions are already loaded and why continuing is cheaper than reloading. |

**Non-negotiable:** every suggestion above MUST include the drafted content ready to paste. The user picks the command and runs it.