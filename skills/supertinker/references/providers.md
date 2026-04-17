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
  options:      string[]  // list of valid choice labels (from node.options keys)
  cwd:          string    // resolved working directory
  model?:       string    // optional model override
  logFile:      string    // path to write raw stdout (already opened by orchestrator)
}
```

## AgentResult

```typescript
interface AgentResult {
  output:          string   // the agent's full text response
  choice:          string   // must match one of ctx.options
  transcriptPath?: string   // optional path to a saved transcript
}
```

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
