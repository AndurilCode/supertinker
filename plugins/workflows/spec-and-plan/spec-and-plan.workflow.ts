import type { Workflow } from "../../../supertinker"

export const workflow: Workflow = {
  id: "spec-and-plan",
  description: "Turn an idea into a reviewed design spec, then a step-by-step implementation plan — inspired by the superpowers brainstorming + writing-plans skills",

  graph: {
    id: "spec-and-plan",
    start: "explore",
    fallback: "paused",
    labels: ["done"],
    nodes: [
      // ────────────────────────────────────────────────────────────────
      // 1. Explore project context + scope-gate the idea
      // ────────────────────────────────────────────────────────────────
      {
        id: "explore",
        agent: "explorer",
        instruction: `The user's idea is in [input].

Your job: produce a concise PROJECT CONTEXT BRIEF that a later agent can use to write a design spec, and decide whether this idea is appropriately-scoped for a single spec.

Steps:
1. Survey the working directory. Read (as relevant): README*, CLAUDE.md, AGENTS.md, CONTRIBUTING.md, package.json / pyproject.toml / Cargo.toml / go.mod, top-level tsconfig/.eslintrc*, and any docs/ index. Skim the root file tree and the most-recently-modified source files. Run \`git log --oneline -n 20\` to see recent direction. Do NOT read the whole codebase.
2. Note the project's language(s), framework(s), test tooling, coding conventions, and architectural patterns actually in use — name the files where you found each fact.
3. Look for existing specs/plans under docs/superpowers/specs/ or docs/superpowers/plans/ that overlap with the idea. Flag any that do.
4. Decide scope: is this idea ONE coherent deliverable (single spec is appropriate), or does it span multiple independent subsystems that each deserve their own spec?
5. Propose a short URL-safe slug for the idea (kebab-case, ≤ 5 words), e.g. "visual-brainstorming-refactor".

Output this EXACT structure and nothing else:

---SLUG---
<the slug>
---CONTEXT---
## Project
<1-3 sentences: what this project is>

## Stack & Conventions
<bulleted facts with file references, e.g. "TypeScript — strict mode (tsconfig.json:14)">

## Relevant Existing Work
<files, commits, or specs that overlap with the idea — or "none">

## Constraints From The Codebase
<any rule from CLAUDE.md / AGENTS.md / CONTRIBUTING.md that constrains the idea; or "none">
---SCOPE-NOTE---
<2-4 sentences: if 'multi', list the independent sub-projects you see and why they need separate specs; if 'single', state the one deliverable and confirm why it's coherent>
---END---

Then end with the sentinel block. Keep the whole output under 1200 words.`,
        slice: ["input"],
        timeout: 600_000,
        options: {
          single: "spec-writer",
          multi:  "decompose",
        },
      },

      // ────────────────────────────────────────────────────────────────
      // 2a. Multi-subsystem branch — write a decomposition doc, pause
      // ────────────────────────────────────────────────────────────────
      {
        id: "decompose",
        agent: "decomposer",
        instruction: `The idea in [input] is too large for one spec. Use [explore] as your project context.

Write a decomposition document to \`docs/superpowers/<slug>-decomposition.md\` (create the directory if missing; the slug is between the ---SLUG--- markers in [explore]; prefix the filename with today's date from \`date +%Y-%m-%d\`, so the final path is \`docs/superpowers/YYYY-MM-DD-<slug>-decomposition.md\`).

The document must contain:
1. **Summary** — one paragraph restating the idea.
2. **Sub-projects** — a numbered list. For each: name, one-sentence goal, external interface (what it exposes to the others), and rough size (S/M/L).
3. **Dependency order** — a short ordered list showing which sub-project must be built before which.
4. **Recommended first spec** — pick one sub-project to tackle first and justify in 2-3 sentences.

After writing the file, commit nothing. Your STDOUT output must be ONLY a status line of the form:

DECOMPOSITION_WRITTEN: <relative path to the file>

Then end with the sentinel block.`,
        slice: ["input", "explore"],
        timeout: 900_000,
        options: { done: "done" },
      },

      // ────────────────────────────────────────────────────────────────
      // 2b. Single-scope branch — write the spec
      // ────────────────────────────────────────────────────────────────
      {
        id: "spec-writer",
        agent: "spec-writer",
        instruction: `Write (or revise) a design spec for the idea in [input].

Use [explore] as your project context. If [review-spec] is present, it contains reviewer feedback from a prior draft — address EVERY issue it flags before writing the new version.

Target file: \`docs/superpowers/specs/<date>-<slug>-design.md\` where:
- <date> is today's date as \`YYYY-MM-DD\` (run \`date +%Y-%m-%d\` to get it).
- <slug> is the value between the ---SLUG--- markers in [explore].

Create parent directories as needed. Overwrite the file on revision.

The spec must have these sections (scale length to the complexity of the idea — short is fine for simple ideas):

# <Feature Title>
**Date:** YYYY-MM-DD
**Status:** Draft (v1) or Draft (vN) on revision

## Problem
What's broken or missing today. Why it matters. Who feels the pain.

## Goals / Non-goals
Bulleted. Be ruthless about non-goals — YAGNI.

## Proposed Approach
The recommended design. 2-3 alternatives considered, each with trade-offs, and why the recommendation wins.

## Architecture
Components and their responsibilities. For each: what it does, how other components use it, what it depends on. If a diagram would help, include it as an ASCII or mermaid block.

## Data Flow
End-to-end walkthrough of the primary use case(s).

## Error Handling
What can go wrong, how the system responds, what the user sees.

## Testing Strategy
Unit / integration / manual — what proves the feature works.

## Open Questions
Anything genuinely undecided. Do NOT use this as a dumping ground for decisions you should have made — every entry must be a real question.

## Out Of Scope
Explicit list of related work that is NOT part of this spec.

## Placeholder audit (do before finalizing)
Before saving, scan your draft for: "TBD", "TODO", "fill in later", vague requirements, contradictions between sections, ambiguity that could be interpreted two ways. Fix them inline.

After writing, your STDOUT output must be ONLY:

SPEC_WRITTEN: <relative path to the spec>
CHANGES: <1-3 bullet list of what's new in this revision, or "initial draft" on v1>

Then end with the sentinel block.`,
        slice: ["input", "explore", "review-spec"],
        timeout: 900_000,
        options: { done: "review-spec" },
      },

      // ────────────────────────────────────────────────────────────────
      // 3. Spec reviewer — approve or request revision
      // ────────────────────────────────────────────────────────────────
      {
        id: "review-spec",
        agent: "spec-reviewer",
        instruction: `Review the design spec just produced by the spec-writer agent.

The spec path was reported in [spec-writer] after the \`SPEC_WRITTEN:\` prefix. Read that file from disk now. Also skim the project context in [explore] and the original idea in [input].

Check for:
1. **Placeholders** — any "TBD", "TODO", "fill in later", vague requirements.
2. **Internal consistency** — sections must not contradict each other.
3. **Scope** — is the spec focused on ONE coherent deliverable, or should it be decomposed?
4. **Ambiguity** — any requirement that could be interpreted two ways.
5. **Coverage of the idea** — does the spec actually address what [input] asked for?
6. **Fit with existing conventions** — any glaring conflict with the facts in [explore].

Calibration: block only on issues that would cause real problems. Minor wording, stylistic preferences, and "nice to have" suggestions do NOT block approval — list them under Recommendations instead.

Output format (no code fences, plain text):

## Spec Review
**Status:** Approved | Needs Revision
**File reviewed:** <path>

**Issues (if any):**
- [Section]: <specific problem> — <why it matters>

**Recommendations (advisory, non-blocking):**
- <suggestion>

If Status is "Approved", select the "approve" option. If "Needs Revision", select "revise". Keep total output under 600 words.`,
        slice: ["input", "explore", "spec-writer"],
        timeout: 600_000,
        options: {
          approve: "plan-writer",
          revise:  "spec-writer",
        },
      },

      // ────────────────────────────────────────────────────────────────
      // 4. Plan writer — turn the approved spec into bite-sized tasks
      // ────────────────────────────────────────────────────────────────
      {
        id: "plan-writer",
        agent: "plan-writer",
        instruction: `Write (or revise) an implementation plan for the spec that was just approved.

Spec path is in [spec-writer] after \`SPEC_WRITTEN:\`. READ the spec file from disk — it is the source of truth, not your memory of what was discussed.
Project context is in [explore].
If [review-plan] is present, it contains reviewer feedback from a prior draft — address every flagged issue.

Target file: \`docs/superpowers/plans/<date>-<slug>.md\` where <date> and <slug> match the spec's filename stem (minus the "-design" suffix). Create parent directories as needed. Overwrite on revision.

Start the file with EXACTLY this header:

\`\`\`markdown
# <Feature Name> Implementation Plan

> **For agentic workers:** Steps use checkbox (\`- [ ]\`) syntax for tracking. Execute tasks in order.

**Goal:** <one sentence>
**Spec:** <relative path to the spec>
**Architecture:** <2-3 sentences>
**Tech Stack:** <key technologies>

---
\`\`\`

Then a **File Structure** section listing every file that will be created or modified and its responsibility.

Then one or more **Task** sections. Each task has this shape:

\`\`\`markdown
### Task N: <Component Name>

**Files:**
- Create: \`exact/path/to/file.ext\`
- Modify: \`exact/path/to/existing.ext:<line-range-if-known>\`
- Test: \`tests/exact/path/to/test.ext\`

- [ ] **Step 1: Write the failing test**
  <full test code in a fenced block>

- [ ] **Step 2: Run test to verify it fails**
  Run: \`<exact command>\`
  Expected: FAIL with "<expected failure>"

- [ ] **Step 3: Write minimal implementation**
  <full code change in a fenced block>

- [ ] **Step 4: Run test to verify it passes**
  Run: \`<exact command>\`
  Expected: PASS

- [ ] **Step 5: Commit**
  \`\`\`bash
  git add <paths>
  git commit -m "<type>: <subject>"
  \`\`\`
\`\`\`

Rules:
- Every step is 2–5 minutes of work.
- Every code step includes the actual code, not a description.
- Every command step includes the exact command and the expected output.
- NEVER write "TBD", "TODO", "implement later", "similar to Task N", "handle edge cases" — these are plan failures.
- DRY, YAGNI, TDD, frequent commits.
- If the project's language doesn't support a TDD flow for a step, replace the test steps with the project's actual verification approach (e.g. run the binary, check output) — but still be concrete.

Before finalizing, self-review:
1. **Spec coverage** — can you point to a task that implements each spec requirement? List any gaps.
2. **Placeholder scan** — search your own draft for the red flags above. Fix any.
3. **Type consistency** — function/method/property names used in later tasks match what's defined in earlier tasks.

Fix issues inline, no re-review needed.

After writing, your STDOUT output must be ONLY:

PLAN_WRITTEN: <relative path to the plan>
TASK_COUNT: <number of tasks>
CHANGES: <1-3 bullets on what's new in this revision, or "initial draft" on v1>

Then end with the sentinel block.`,
        slice: ["input", "explore", "spec-writer", "review-plan"],
        timeout: 1_200_000,
        options: { done: "review-plan" },
      },

      // ────────────────────────────────────────────────────────────────
      // 5. Plan reviewer — approve or request revision
      // ────────────────────────────────────────────────────────────────
      {
        id: "review-plan",
        agent: "plan-reviewer",
        instruction: `Review the implementation plan just produced.

Plan path is in [plan-writer] after \`PLAN_WRITTEN:\`. Spec path is in [spec-writer] after \`SPEC_WRITTEN:\`. Read BOTH files from disk.

Check:
| Category | What to look for |
|----------|------------------|
| Completeness | TODOs, placeholders, incomplete tasks, missing steps |
| Spec alignment | Every spec requirement has a task that implements it; no major scope creep |
| Task decomposition | Tasks have clear boundaries; steps are 2-5 minutes and actionable |
| Concreteness | Code steps include actual code; command steps include actual commands + expected output |
| Type/name consistency | Names used across tasks match |
| Buildability | Could an engineer with no prior context follow this and ship working code? |

Calibration: approve unless there are serious gaps — missing requirements from the spec, contradictory steps, placeholder content, or tasks so vague they can't be acted on. Minor wording and stylistic preferences are Recommendations, not Issues.

Output format:

## Plan Review
**Status:** Approved | Needs Revision
**Plan file:** <path>
**Spec file:** <path>

**Issues (if any):**
- [Task X, Step Y]: <specific problem> — <why it matters for implementation>

**Missing spec requirements (if any):**
- <requirement from spec> — <no task covers it>

**Recommendations (advisory, non-blocking):**
- <suggestion>

If Status is "Approved", select "approve". If "Needs Revision", select "revise". Keep total output under 800 words.`,
        slice: ["input", "explore", "spec-writer", "plan-writer"],
        timeout: 600_000,
        options: {
          approve: "done",
          revise:  "plan-writer",
        },
      },

      // ────────────────────────────────────────────────────────────────
      // Terminals
      // ────────────────────────────────────────────────────────────────
      { id: "done",   type: "done" },
      { id: "paused", type: "paused" },
    ],
  },

  registry: {
    explorer: {
      command: "claude",
      model: "sonnet",
      systemPrompt: "You are a senior engineer doing project reconnaissance before a design exercise. You read the filesystem efficiently — README, top-level config files, CLAUDE.md / AGENTS.md / CONTRIBUTING.md, a handful of recently-modified source files, and `git log --oneline -n 20`. You do NOT read the whole codebase. You produce compact, fact-dense briefs with file references for every claim. You are ruthless about scope: if a user's idea spans multiple independent subsystems, you call that out instead of pretending it's one project. Keep output under 1200 words.",
    },
    decomposer: {
      command: "claude",
      model: "sonnet",
      systemPrompt: "You break a large feature idea into independent sub-projects that each deserve their own spec. You write a single decomposition document to disk with sub-project names, goals, interfaces, rough sizes, and a dependency order. You are the filesystem agent — you WRITE the file; your stdout is just a status line reporting the path. Keep the decomposition doc under 600 words.",
    },
    "spec-writer": {
      command: "claude",
      model: "sonnet",
      systemPrompt: "You are a design-spec author. Given an idea and project context, you produce a focused design spec and write it to disk at the exact path the instruction specifies. You follow the section template exactly. You scale each section's length to its complexity — short for simple ideas, deeper for nuanced ones. You apply YAGNI ruthlessly: non-goals and out-of-scope sections are as important as goals. You consider at least 2-3 alternative approaches before committing to one, and you document the trade-offs. Before finalizing you self-audit for placeholders (TBD, TODO, vague requirements), internal contradictions, and ambiguity — and fix them inline. On revision passes, you address every issue the reviewer raised. Your stdout is ONLY the status line prefixed with SPEC_WRITTEN:",
    },
    "spec-reviewer": {
      command: "claude",
      model: "sonnet",
      systemPrompt: "You are a senior design-spec reviewer. You read the spec file from disk, compare it against the original idea and the project context, and decide whether it's approved or needs revision. You block ONLY on real problems: placeholders, internal contradictions, scope that should have been decomposed, ambiguity that could be interpreted two ways, or requirements from the idea that the spec fails to address. Stylistic preferences and nice-to-haves go in Recommendations, not Issues — they do not block approval. You are calibrated: approve when the spec would produce a working plan, even if it isn't perfect.",
    },
    "plan-writer": {
      command: "claude",
      model: "sonnet",
      systemPrompt: "You are an implementation-plan author. Given an approved design spec, you produce a bite-sized, TDD-flavored implementation plan and write it to disk at the exact path the instruction specifies. You assume the engineer has zero context for this codebase. Every code step contains the actual code; every command step contains the exact command and expected output. Each step is 2-5 minutes of work. You NEVER write 'TBD', 'TODO', 'implement later', 'similar to Task N', 'handle edge cases', or 'write tests for the above' without the test code. You self-review for spec coverage, placeholders, and name consistency before finalizing. On revision passes, you address every issue the reviewer raised. Your stdout is ONLY the status line prefixed with PLAN_WRITTEN:",
    },
    "plan-reviewer": {
      command: "claude",
      model: "sonnet",
      systemPrompt: "You are a senior implementation-plan reviewer. You read both the plan file and the spec file from disk, then decide whether the plan is ready for an engineer to execute. You block ONLY on real problems: TODO/placeholder content, spec requirements with no implementing task, vague or non-actionable steps, contradictions between tasks, or name/type inconsistencies. Stylistic preferences and nice-to-haves go in Recommendations, not Issues — they do not block approval. You are calibrated: approve when an engineer with no prior context could follow the plan to working code, even if it isn't perfect.",
    },
  },

  guardrails: {
    maxIterations: 4,
    post: [
      // Writer outputs must report a file path, not just narrate.
      { nodeId: "spec-writer",  check: "/SPEC_WRITTEN:\\s*\\S+/.test(output)",         reason: "spec-writer must report the spec file path with the SPEC_WRITTEN: prefix" },
      { nodeId: "plan-writer",  check: "/PLAN_WRITTEN:\\s*\\S+/.test(output)",         reason: "plan-writer must report the plan file path with the PLAN_WRITTEN: prefix" },
      { nodeId: "decompose",    check: "/DECOMPOSITION_WRITTEN:\\s*\\S+/.test(output)", reason: "decompose must report the decomposition file path with the DECOMPOSITION_WRITTEN: prefix" },
      // Explorer must emit the slug block so downstream agents can build filenames.
      { nodeId: "explore",      check: "/---SLUG---[\\s\\S]*?---CONTEXT---/.test(output)", reason: "explorer must emit the ---SLUG--- block so downstream agents can derive the filename" },
      // Reviewers must produce a substantive report, not a one-liner.
      { nodeId: "review-spec",  check: "output.trim().length > 120", reason: "spec-reviewer output is too short to be a real review" },
      { nodeId: "review-plan",  check: "output.trim().length > 120", reason: "plan-reviewer output is too short to be a real review" },
    ],
  },
}
