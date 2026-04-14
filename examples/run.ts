import { run } from "../supertinker"
import { workflow } from "./workflow"

run({
  workflow,
  initialContext: {
    task: "Create a simple TypeScript function in /tmp/supertinker-demo/utils.ts that computes the Fibonacci sequence up to N using memoization. Include JSDoc comments and export the function."
  }
}).catch(err => {
  console.error("Run failed:", err)
  process.exit(1)
})
