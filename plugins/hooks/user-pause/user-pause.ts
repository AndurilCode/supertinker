import { existsSync, unlinkSync } from "fs"
import { join } from "path"
import type { Hook, HookEvent, HookDirective } from "../../../supertinker.js"

export const hook: Hook = {
  name: "user-pause",
  description: "Pauses the workflow when the user requests it from the dashboard",
  events: ["PreAgent"],
  parallel: false,
  priority: 10,

  handler: async (event: HookEvent): Promise<HookDirective> => {
    const pauseFile = join(event.runDir, "pause-requested")
    if (existsSync(pauseFile)) {
      try { unlinkSync(pauseFile) } catch {}
      return { action: "pause", reason: "User requested pause from dashboard" }
    }
    return { action: "continue" }
  },
}
