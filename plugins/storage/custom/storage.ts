import { mkdirSync, writeFileSync } from "fs"
import { join } from "path"
import type { StorageAdapter } from "../../../supertinker.js"

const PROJECT_WORKFLOWS = join(process.cwd(), ".supertinker", "workflows")

export const storage: Partial<StorageAdapter> = {
  async saveWorkflow(id, content) {
    mkdirSync(PROJECT_WORKFLOWS, { recursive: true })
    writeFileSync(join(PROJECT_WORKFLOWS, `${id}.workflow.ts`), content)
  },
}
