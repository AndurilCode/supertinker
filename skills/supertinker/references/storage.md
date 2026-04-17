# Storage Adapters

A storage adapter customises where run state is persisted. Place it in `.supertinker/storage/storage.ts`. You only need to implement the methods you want to override — the rest delegate to the built-in filesystem adapter.

## Required Export

```typescript
import type { StorageAdapter } from "supertinker"

export const storage: Partial<StorageAdapter> = {
  // override only what you need
}
```

## Full Interface

```typescript
interface StorageAdapter {
  createRun(runId: string): Promise<string>
  // returns runDir — the root path for this run's artifacts

  saveContext(runDir: string, context: Context): Promise<void>
  loadContext(runDir: string): Promise<Context>

  savePause(runDir: string, state: PausedState): Promise<void>
  loadPause(runDir: string): Promise<PausedState>
  pauseExists(runDir: string): Promise<boolean>

  appendLog(runDir: string, line: string): Promise<void>
  saveFile(runDir: string, name: string, content: string): Promise<void>

  saveWorkflow(id: string, content: string): Promise<void>
  // persist a generated workflow to the library

  logPath(runDir: string, nodeId: string): string
  // return the path the provider should write raw stdout to

  resolveWorkflow(name: string): Promise<string | null>
  // given a workflow name/id, return the absolute file path or null

  listWorkflows(): Promise<Array<{
    id: string
    description: string
    file: string
    source: string   // "project" | "library" | "built-in"
  }>>
}
```

## Example: Save Workflows to Project Directory

```typescript
import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { StorageAdapter } from "supertinker"

export const storage: Partial<StorageAdapter> = {
  async saveWorkflow(id, content) {
    const dir = join(process.cwd(), ".supertinker", "workflows")
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${id}.workflow.ts`), content)
  },
}
```
