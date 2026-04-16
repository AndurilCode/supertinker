import { execFile, spawn } from "child_process"
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

/**
 * macOS notification hook.
 *
 * Sends system notifications (osascript banner + afplay sound) when:
 * - An agent finishes a node (PostAgent)
 * - Human review is required (Paused)
 * - The workflow completes or fails (RunEnd)
 *
 * Sound plays via afplay (always audible regardless of macOS throttling).
 * Banners may be throttled by macOS if events fire in quick succession,
 * but in real runs agents are minutes apart so banners appear reliably.
 */

const SOUNDS: Record<string, string> = {
  default: "/System/Library/Sounds/Tink.aiff",
  Glass:   "/System/Library/Sounds/Glass.aiff",
  Purr:    "/System/Library/Sounds/Purr.aiff",
  Basso:   "/System/Library/Sounds/Basso.aiff",
}

function notify(title: string, message: string, sound = "default"): void {
  const script = `display notification ${JSON.stringify(message)} with title ${JSON.stringify(title)}`
  execFile("osascript", ["-e", script], (err) => {
    if (err) process.stderr.write(`NOTIFY-ERR: ${err.message}\n`)
  })
  const soundFile = SOUNDS[sound] ?? SOUNDS.default
  spawn("afplay", [soundFile], { stdio: "ignore", detached: true }).unref()
}

export const hook: Hook = {
  name: "notify",
  description: "macOS system notifications for agent completion, pauses, and run end",
  events: ["PostAgent", "Paused", "RunEnd"],
  parallel: true,
  priority: 90, // low priority — purely observational, runs after core hooks

  handler: async (event: HookEvent): Promise<HookDirective> => {
    switch (event.event) {
      case "PostAgent": {
        const e = event as Extract<HookEvent, { event: "PostAgent" }>
        notify(
          "Agent Finished",
          `Node "${e.nodeId}" completed (choice: ${e.result.choice})`,
        )
        break
      }

      case "Paused": {
        const e = event as Extract<HookEvent, { event: "Paused" }>
        notify(
          "Human Review Required",
          e.reason
            ? `Node "${e.nodeId}" paused: ${e.reason}`
            : `Node "${e.nodeId}" is waiting for your input`,
          "Purr",
        )
        break
      }

      case "RunEnd": {
        const e = event as Extract<HookEvent, { event: "RunEnd" }>
        const ok = e.terminal === "done"
        notify(
          ok ? "Workflow Complete" : "Workflow Failed",
          ok
            ? `Run ${event.runId} finished successfully`
            : `Run ${event.runId} failed`,
          ok ? "Glass" : "Basso",
        )
        break
      }
    }

    return { action: "continue" }
  },
}
