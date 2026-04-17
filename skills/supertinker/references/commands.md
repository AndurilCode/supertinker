# Commands

A command plugin adds a new CLI subcommand to supertinker. Place it in `.supertinker/commands/my-command.ts`. Installed commands appear in `supertinker --help`.

## Required Export

```typescript
import type { CommandPlugin } from "supertinker"

export const command: CommandPlugin = {
  name:        "my-command",
  description: "What it does",
  usage:       "my-command <subcommand> [--flag value]",  // optional, shown in --help
  handler:     async (args, get) => {
    // args: argv after the command name (e.g. ["create", "--name", "foo"])
    // get:  helper to extract flag values — get("--name") returns "foo"
  },
}
```

## CommandPlugin Interface

```typescript
interface CommandPlugin {
  name:        string
  description: string
  usage?:      string
  handler:     (args: string[], get: (flag: string) => string | undefined) => Promise<void>
}
```

The `handler` receives:
- `args` — everything after the command name in `argv` (e.g. for `supertinker schedule create --workflow meta`, args is `["create", "--workflow", "meta"]`)
- `get(flag)` — returns the value after `flag` in argv, or `undefined` if not present (e.g. `get("--workflow")` returns `"meta"`)

## Discovery & Invocation

Command plugins are discovered from the same search path as other plugins:

```
.supertinker/commands/   ← project-local (highest priority)
~/.supertinker/commands/ ← user-global
<supertinker-install>/commands/ ← built-in (lowest priority)
```

The filename (minus extension) is the command name. `schedule.ts` → `supertinker schedule`.

First match wins — a project-local command overrides a global one with the same name.

## Example: Minimal Command

```typescript
import type { CommandPlugin } from "supertinker"

export const command: CommandPlugin = {
  name:        "hello",
  description: "Print a greeting",
  usage:       "hello [--name <name>]",
  async handler(args, get) {
    const name = get("--name") ?? "world"
    console.log(`Hello, ${name}!`)
  },
}
```

## Example: Command with Subcommands

```typescript
import type { CommandPlugin } from "supertinker"

export const command: CommandPlugin = {
  name:        "cache",
  description: "Manage the workflow cache",
  usage:       "cache <clear|stats>",
  async handler(args, get) {
    const sub = args[0]
    if (sub === "clear") {
      // clear cache logic
      console.log("Cache cleared.")
    } else if (sub === "stats") {
      // show stats logic
      console.log("Cache entries: 42")
    } else {
      console.log("Usage: supertinker cache <clear|stats>")
    }
  },
}
```

## Manifest

For distribution via `$ST plugins install`, include a `manifest.json`:

```json
{
  "name": "my-command",
  "type": "command",
  "description": "What it does",
  "files": ["my-command.ts"],
  "version": "1.0.0"
}
```
