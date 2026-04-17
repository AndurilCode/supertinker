/**
 * chat — interactive REPL for persistent-agent workflows.
 *
 * Thin CLI shim. All UI (including the boot/attach logic that used to live
 * here) happens in chat-ui.tsx so the Ink spinner covers startup.
 *
 *   supertinker chat --workflow director            # auto-start fresh run
 *   supertinker chat --workflow director --run <id> # attach to existing
 */

import { dirname }               from "path"
import { fileURLToPath }          from "url"
import type { CommandPlugin }     from "../../../cli.js"

export const command: CommandPlugin = {
  name: "chat",
  description: "interactive REPL (Ink TUI) for persistent-agent workflows",
  usage: "chat [--workflow <name>] [--run <runId>] [--choice <label>=event] [--context-key <k>=event] [--reply-key <k>]   # workflow defaults to 'director'",
  async handler(_args, get) {
    // Default to 'director' — the canonical persistent-agent workflow shipped
    // with supertinker. Any other persistent-style workflow still works via
    // --workflow explicitly.
    const workflow   = get("--workflow")    ?? "director"
    const runId      = get("--run")
    const choice     = get("--choice")      ?? "event"
    const contextKey = get("--context-key") ?? "event"
    const replyKey   = get("--reply-key")   ?? workflow

    // Clear terminal (scrollback + visible) so the prior shell prompt doesn't
    // bleed into the chat UI. Ink renders from cursor-home onward.
    process.stdout.write("\x1b[2J\x1b[3J\x1b[H")

    const here   = dirname(fileURLToPath(import.meta.url))
    const uiPath = `${here}/chat-ui.tsx`
    const ui     = await import(uiPath)
    ui.mountChat({ runId, workflow, choice, contextKey, replyKey: replyKey! })
  },
}
