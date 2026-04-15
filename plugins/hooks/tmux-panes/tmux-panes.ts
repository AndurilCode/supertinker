import { spawn } from "child_process"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

function tmuxRunning(): boolean { return !!process.env.TMUX }

function tmux(action: "new-window" | "kill-window", name: string, cmd?: string): void {
  if (!tmuxRunning()) return
  try {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 20)
    const args = action === "new-window" ? [action, "-n", safe, cmd!] : [action, "-t", safe]
    spawn("tmux", args, { detached: true, stdio: "ignore" }).unref()
  } catch { /* not in tmux */ }
}

export const hook: Hook = {
  name: "tmux-panes",
  description: "Opens tmux panes for orchestrator log and per-agent log tailing",
  events: ["RunStart", "PreProvider", "PostAgent", "Error"],
  parallel: true,
  priority: 90,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    switch (event.event) {
      case "RunStart": {
        tmux("new-window", "orch-log", `tail -f ${join(event.runDir, "orchestrator.log")}`)
        break
      }
      case "PreProvider": {
        const e = event as Extract<HookEvent, { event: "PreProvider" }>
        tmux("new-window", `node-${e.nodeId}`, `tail -f ${e.logFile}`)
        break
      }
      case "PostAgent": {
        const e = event as Extract<HookEvent, { event: "PostAgent" }>
        setTimeout(() => tmux("kill-window", `node-${e.nodeId}`), 800)
        break
      }
      case "Error": {
        const e = event as Extract<HookEvent, { event: "Error" }>
        setTimeout(() => tmux("kill-window", `node-${e.nodeId}`), 800)
        break
      }
    }
    return { action: "continue" }
  },
}
