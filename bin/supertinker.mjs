#!/usr/bin/env node
import { fileURLToPath } from "url"
import { dirname, join } from "path"
import { execFileSync } from "child_process"

const __dirname = dirname(fileURLToPath(import.meta.url))
const cli = join(__dirname, "..", "cli.ts")
const args = process.argv.slice(2)

// Try bun first (fastest), fall back to tsx, then node --experimental-strip-types
const runners = [
  { cmd: "bun", args: [cli, ...args] },
  { cmd: "npx", args: ["tsx", cli, ...args] },
  { cmd: "node", args: ["--experimental-strip-types", cli, ...args] },
]

for (const runner of runners) {
  try {
    execFileSync(runner.cmd, runner.args, {
      stdio: "inherit",
      cwd: process.cwd(),
      env: process.env,
    })
    process.exit(0)
  } catch (err) {
    if (err.status !== undefined) process.exit(err.status)
    // Command not found — try next runner
  }
}

console.error("supertinker requires bun, tsx, or node >= 22.6 (--experimental-strip-types)")
process.exit(1)
