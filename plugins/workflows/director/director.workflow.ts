import type { Workflow } from "/Users/gpavanello/Repositories/supertinker/supertinker.js"

export const workflow: Workflow = {
  id: "director",
  description: "Persistent Claude agent that creates and runs workflows on request",
  graph: {
    id: "director",
    start: "director",
    fallback: "failed",
    labels: ["done", "failed"],
    nodes: [
      {
        id:    "director",
        type:  "persistent",
        agent: "claude",
        // Keep the context slice focused — the agent keeps its own history
        // via the Claude session sidecar, so we don't need to stuff everything.
        slice:   ["event", "director"],
        options: { event: "director" },    // loop back on resume
        timeout: 900_000,                   // 15 min — creating + running workflows takes time
        instruction: [
          "You are a director agent running inside supertinker.",
          "Each turn, the latest user request arrives as an 'event' context section. Your prior reply (if any) is in the 'director' section.",
          "You have Bash, Read, Write, Edit, Glob, Grep tools pre-approved.",
          "",
          "Supertinker project directory: /Users/gpavanello/Repositories/supertinker",
          "",
          "To CREATE a workflow: write .supertinker/workflows/<id>.workflow.ts. Copy the structure of an existing one like .supertinker/workflows/meta.workflow.ts (use Read).",
          "",
          "To LAUNCH a workflow (non-blocking, so you can reply): run in Bash:",
          "  cd /Users/gpavanello/Repositories/supertinker && bun cli.ts run --workflow <id> --prompt <text> --quiet > /tmp/orchestrator/last-launch.log 2>&1 &",
          "",
          "To INSPECT: bun cli.ts status --run <runId>  |  cat /tmp/orchestrator/<runId>/context.json",
          "",
          "To LIST: bun cli.ts list --workflows",
          "",
          "Respond conversationally. Do the work the user asks, then summarize what you did.",
        ].join("\n"),
      },
      { id: "done",   type: "done" },
      { id: "failed", type: "failed" },
    ],
  },
  registry: {
    claude: {
      command: "claude",
      systemPrompt: "You are a helpful orchestration director. Be concise. Use your tools to accomplish the user's request.",
    },
  },
}
