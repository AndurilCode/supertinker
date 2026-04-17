# Providers

A provider wraps an external agent CLI. Place it in `.supertinker/providers/my-provider.ts`.

## Required Export

```typescript
import type { ProviderContext, AgentResult } from "supertinker"

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  // ...
}
```

## ProviderContext

```typescript
interface ProviderContext {
  userPrompt:   string    // rendered context + instruction
  systemPrompt: string    // agent system prompt
  options:      string[]  // list of valid choice labels (from node.options keys; may be empty for free-form callers like persistent nodes)
  cwd:          string    // resolved working directory
  model?:       string    // optional model override
  logFile:      string    // path to write raw stdout (already opened by orchestrator)
  onChunk?:     (chunk: string) => void   // streaming: call per chunk as text arrives
  signal?:      AbortSignal                // abort signal — throw/return when signal.aborted
}
```

## AgentResult

```typescript
interface AgentResult {
  output:          string   // the agent's full text response
  choice:          string   // must match one of ctx.options (or any non-empty marker if options is empty)
  transcriptPath?: string   // optional path to a saved transcript
  metadata?:       Record<string, unknown>  // optional provider-specific metadata (sessionId, streaming flag, etc.)
}
```

## Streaming (optional)

If `ctx.onChunk` is defined, the caller opted into streaming. Forward each incremental text chunk via `ctx.onChunk(chunk)` — the orchestrator fans it out to `PartialAgent` hooks. Check `ctx.signal?.aborted` between chunks and exit promptly if set (a hook may have requested `abort`). Streaming calls typically skip strict output schemas since the incremental protocol can't carry structured constraints.

## Sentinel Block Convention

The orchestrator injects this into the system prompt automatically when a node has `options`. Your provider must parse it from the agent's response:

```
---CHOICE---
<label>
---END---
```

Extract with: `/---CHOICE---\s*(\S+)\s*---END---/`.

## Minimal Provider Example

```typescript
import { spawnSync } from "child_process"
import { writeFileSync } from "fs"
import type { ProviderContext, AgentResult } from "supertinker"

export async function invoke(ctx: ProviderContext): Promise<AgentResult> {
  const input = JSON.stringify({ system: ctx.systemPrompt, prompt: ctx.userPrompt })
  const result = spawnSync("my-cli", ["--json"], {
    input,
    cwd: ctx.cwd,
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  })

  const output = result.stdout ?? ""
  writeFileSync(ctx.logFile, output)

  const match = output.match(/---CHOICE---\s*(\S+)\s*---END---/)
  const choice = match?.[1] ?? ctx.options[0] ?? "next"

  return { output, choice }
}
```
