import type { Workflow, GuardrailCheck } from "../supertinker"

// Plan output must contain ## Steps and ## Files sections
const planHasStructure: GuardrailCheck = ({ nodeId, output }) => {
  if (nodeId !== "plan" || !output) return { pass: true }
  if (!output.includes("## Steps")) return { pass: false, reason: "Plan missing '## Steps' section" }
  if (!output.includes("## Files")) return { pass: false, reason: "Plan missing '## Files' section" }
  return { pass: true }
}

// No secrets in output
const noSecrets: GuardrailCheck = ({ output }) => {
  if (!output) return { pass: true }
  if (/(?:sk-|ghp_|AKIA)[A-Za-z0-9]{10,}/.test(output)) {
    return { pass: false, reason: "Output appears to contain an API key or secret" }
  }
  return { pass: true }
}

export const workflow: Workflow = {
  id: "plan-develop-review",
  description: "Plan, implement, and review a TypeScript feature with multi-agent collaboration",

  guardrails: {
    post: [planHasStructure, noSecrets],
    maxIterations: 3,
  },

  registry: {
    planner: {
      command: "claude",
      model: "sonnet",
      systemPrompt: `You are a planning agent.
Analyze the task and produce a structured implementation plan in this format:

## Steps
1. ...

## Files
- path/to/file.ts — description`
    },

    claude_code: {
      command: "claude",
      model: "sonnet",
      systemPrompt: `You are a senior TypeScript engineer.
Implement the plan precisely and completely.

When done, summarize in this format:

## Implemented
- what was done

## Notes
- anything the reviewer should know`
    },

    reviewer: {
      command: "copilot",
      systemPrompt: `You are a senior code reviewer.
Review the implementation against the plan.

Produce your review in this format:

## Verdict
approved | needs_work

## Feedback
- specific issues or confirmation`
    }
  },

  graph: {
    id: "plan-develop-review",
    start: "plan",
    fallback: "human_review",
    labels: ["done", "approved", "needs_work", "needs_clarify"],

    nodes: [
      {
        id: "plan",
        agent: "planner",
        instruction: "Analyze the task and produce a detailed implementation plan",
        options: {
          done:          "develop",
          needs_clarify: "human_review"
        }
      },
      {
        id: "develop",
        agent: "claude_code",
        slice: ["task", "plan"],
        instruction: "Implement the plan described in [plan]",
        options: {
          done:          "review",
          needs_clarify: "human_review"
        }
      },
      {
        id: "review",
        agent: "reviewer",
        slice: ["task", "plan", "develop"],
        instruction: "Review the implementation in [develop] against the plan in [plan]",
        options: {
          approved:   "complete",
          needs_work: "develop"
        }
      },

      { id: "complete",     type: "done"   },
      { id: "human_review", type: "paused" }
    ]
  }
}
