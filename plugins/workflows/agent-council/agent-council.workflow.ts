import type { Workflow } from "../../../supertinker"

/**
 * agent-council
 *
 * Fork a code review across three independently-trained agents — Codex,
 * Gemini, Claude — each using its native CLI. They review the same codebase
 * in parallel under their own training bias, then a synthesizer (Claude)
 * merges the three reports into a unified review and writes it to disk.
 *
 * The goal is deliberate model diversity: each reviewer's different training
 * distribution becomes a different "lens" (OpenAI's RLHF, Google's RLHF,
 * Anthropic's RLHF) applied to the same input.
 */

const SHARED_INSTRUCTION = `You are on a three-member code review council. Review the codebase and/or diff below thoroughly, under the lens of your own training and engineering judgement.

Review scope — cover all of these in your own words:
- Architecture & design: cohesion, coupling, layering, extensibility
- Correctness: edge cases, error handling, race conditions, resource leaks
- Security: injection, authn/z, secrets, input validation, supply chain
- Quality: readability, naming, DRY/duplication, complexity, testability
- Project conventions: read CLAUDE.md / AGENTS.md / CONTRIBUTING.md / README.md / lint configs if present and verify adherence
- Performance & scalability where relevant

Read real files in the working directory — don't guess from the prompt alone.

Output format — for every finding:
FILE: <path>
LINE: <number or range, or "N/A">
SEVERITY: critical | high | warning | suggestion
CATEGORY: architecture | correctness | security | quality | conventions | performance
FINDING: <concise statement of what is wrong>
FIX: <specific change you'd make>
---

Finish with a short "## Council Verdict — <your-name>" paragraph capturing:
- Overall impression
- The one insight you believe is most distinctive to your perspective
- Approve / request-changes / needs-discussion

Be direct. Disagreement with the other reviewers is welcome — we will synthesize later.`

export const workflow: Workflow = {
  id: "agent-council",
  description:
    "Three-agent council (Codex, Gemini, Claude) review the codebase in parallel under their own training biases, then a synthesizer merges the reports.",

  graph: {
    id: "agent-council",
    start: "fork-council",
    fallback: "paused",
    labels: ["done"],
    nodes: [
      {
        id: "fork-council",
        type: "fork",
        targets: ["review-codex", "review-gemini", "review-claude"],
      },

      {
        id: "review-codex",
        agent: "codex-reviewer",
        instruction: SHARED_INSTRUCTION,
        slice: ["task", "cwd"],
        timeout: 1_200_000, // 20 min — repo-wide reviews can be long
        options: { done: "synthesize" },
      },
      {
        id: "review-gemini",
        agent: "gemini-reviewer",
        instruction: SHARED_INSTRUCTION,
        slice: ["task", "cwd"],
        timeout: 1_200_000,
        options: { done: "synthesize" },
      },
      {
        id: "review-claude",
        agent: "claude-reviewer",
        instruction: SHARED_INSTRUCTION,
        slice: ["task", "cwd"],
        timeout: 1_200_000,
        options: { done: "synthesize" },
      },

      {
        id: "synthesize",
        type: "join",
        waits_for: ["review-codex", "review-gemini", "review-claude"],
        agent: "synthesizer",
        instruction: `You have three independent code review reports produced by different frontier models — each reflecting the bias of its own training distribution.

## Codex Review
[review-codex]

## Gemini Review
[review-gemini]

## Claude Review
[review-claude]

Synthesize them into a single "Agent Council Review" document with these sections:

### 1. Points of Consensus
Findings that TWO OR MORE reviewers independently raised. For each, cite which reviewers agreed and what they said — this is the strongest signal.

### 2. Unique Insights (per reviewer)
For EACH of the three reviewers, list 2–4 findings that ONLY they raised. This surfaces the perspective diversity.

### 3. Disagreements
Places where reviewers take opposing positions. Present both sides, then give your adjudication with reasoning.

### 4. Unified Inline Comments
A deduplicated, severity-sorted list. Each entry:
- **file:line** — exact location
- **severity** — critical | high | warning | suggestion
- **category**
- Comment text with concrete fix
- (sources: codex | gemini | claude, any combination)

### 5. Executive Summary
- Overall verdict (approve / request-changes / needs-discussion)
- Top 3 critical items requiring immediate action
- What the diversity of perspectives revealed that no single reviewer would have

IMPORTANT: Write the full review to a file called "agent-council-review.md" in the working directory. That file IS your deliverable — do not just print it to chat. Confirm in your reply that the file was written and give the absolute path.`,
        options: { done: "done" },
        timeout: 900_000,
      },

      { id: "done",   type: "done" },
      { id: "paused", type: "paused" },
    ],
  },

  registry: {
    "codex-reviewer": {
      command: "codex",
      systemPrompt:
        "You are an expert code reviewer operating via the Codex CLI. You read the real files in the working directory to gain full context. You produce structured, actionable findings. Lean into the engineering priors from your own training — be direct about performance, correctness, and architectural smells. Keep output under 2500 words; skip style nits a formatter would catch.",
    },
    "gemini-reviewer": {
      command: "gemini",
      systemPrompt:
        "You are an expert code reviewer operating via the Gemini CLI. You read the real files in the working directory to gain full context. You produce structured, actionable findings. Lean into the engineering priors from your own training — bring your own perspective on maintainability, safety, and design. Keep output under 2500 words; skip style nits a formatter would catch.",
    },
    "claude-reviewer": {
      command: "claude",
      systemPrompt:
        "You are an expert code reviewer operating via the Claude CLI. You read the real files in the working directory to gain full context. You produce structured, actionable findings. Lean into the engineering priors from your own training — emphasize clarity, safety, and long-term maintainability. Keep output under 2500 words; skip style nits a formatter would catch.",
    },
    synthesizer: {
      command: "claude",
      systemPrompt:
        "You are a senior engineering lead who synthesizes multiple code reviews into a single coherent document. You highlight consensus, preserve minority insights, adjudicate disagreements with reasoning, and produce a PR-ready review. You always write the final deliverable to disk as 'agent-council-review.md' in the working directory.",
    },
  },

  guardrails: {
    maxIterations: 2,
    post: [
      {
        check: "output.trim().length > 200",
        reason:
          "reviewer output is too short — must contain substantive findings across multiple categories",
      },
    ],
  },
}
