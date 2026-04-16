import type { Workflow } from "../../../supertinker"

export const workflow: Workflow = {
  id: "code-review",
  description: "Multi-lens code review: quality, security, and project rules — produces inline comments and summary",

  graph: {
    id: "code-review",
    start: "fork-lenses",
    fallback: "paused",
    labels: ["done"],
    nodes: [
      {
        id: "fork-lenses",
        type: "fork",
        targets: ["review-quality", "review-security", "review-rules"],
      },
      {
        id: "review-quality",
        agent: "quality-reviewer",
        instruction: `Review the code/diff below through the lens of CODE QUALITY.

Focus areas:
- Readability and naming conventions
- Maintainability and modularity
- DRY violations and code duplication
- Complexity (cyclomatic, cognitive)
- Error handling correctness
- Design patterns and anti-patterns
- Test coverage gaps

For each finding, output this exact format:
FILE: <path>
LINE: <number or range>
SEVERITY: critical | warning | suggestion
FINDING: <concise description>
FIX: <what to change>

End with a brief summary paragraph of overall code quality.`,
        slice: ["input"],
        timeout: 900_000,
        options: { done: "synthesize" },
      },
      {
        id: "review-security",
        agent: "security-reviewer",
        instruction: `Review the code/diff below through the lens of SECURITY.

Focus areas:
- OWASP Top 10 vulnerabilities
- Injection attacks (SQL, command, XSS, template)
- Authentication and authorization flaws
- Hardcoded secrets or credentials
- Insecure dependencies or imports
- Input validation and sanitization gaps
- Sensitive data exposure
- Cryptographic weaknesses
- Race conditions and TOCTOU bugs

For each finding, output this exact format:
FILE: <path>
LINE: <number or range>
SEVERITY: critical | high | medium | low
VULNERABILITY: <type, e.g. "Command Injection">
FINDING: <description of the issue>
REMEDIATION: <specific fix>

End with a brief threat summary.`,
        slice: ["input"],
        timeout: 900_000,
        options: { done: "synthesize" },
      },
      {
        id: "review-rules",
        agent: "rules-reviewer",
        instruction: `Review the code/diff below through the lens of PROJECT RULES ADHERENCE.

First, search the working directory for project convention files:
- CLAUDE.md, AGENTS.md, CONTRIBUTING.md
- .editorconfig, .eslintrc*, .prettierrc*, tsconfig.json
- Any README sections about conventions
- Architecture decision records (ADRs)

Then check whether the code follows every stated rule. If no project rules files exist, review against widely-accepted community standards for the language/framework.

For each deviation, output this exact format:
FILE: <path>
LINE: <number or range>
SEVERITY: critical | warning | suggestion
RULE: <the specific rule or convention being violated>
SOURCE: <file where the rule is documented, or "community standard">
FINDING: <what violates it>
FIX: <how to comply>

End with a brief compliance summary.`,
        slice: ["input"],
        timeout: 900_000,
        options: { done: "synthesize" },
      },
      {
        id: "synthesize",
        type: "join",
        waits_for: ["review-quality", "review-security", "review-rules"],
        agent: "synthesizer",
        instruction: `You have three independent code review reports:

## Code Quality Review
[review-quality]

## Security Review
[review-security]

## Project Rules Review
[review-rules]

Synthesize them into a single, unified code review with two sections:

### 1. INLINE COMMENTS
A deduplicated list of specific, actionable comments. Each entry:
- **file:line** — the exact location
- **severity** — critical, high, warning, or suggestion
- **category** — quality, security, or rules
- The comment text with concrete fix suggestion

Sort by: severity (critical first), then file path. Merge duplicates — if two lenses flagged the same line, combine into one comment noting both perspectives.

### 2. SUMMARY
A concise executive summary:
- Overall verdict (approve / request changes / needs discussion)
- Critical issues requiring immediate attention (if any)
- Key themes across the three lenses
- Recommended priority order for the author

Keep it actionable. No filler.`,
        options: { done: "done" },
      },
      { id: "done", type: "done" },
      { id: "paused", type: "paused" },
    ],
  },

  registry: {
    "quality-reviewer": {
      command: "claude",
      systemPrompt: "You are an expert code reviewer specializing in code quality. You have deep knowledge of software engineering best practices, design patterns, clean code principles, and language-specific idioms. You read the actual files in the working directory to understand full context beyond the diff. You produce structured, actionable findings with exact file and line references. Be thorough but pragmatic — flag real problems, not style nitpicks that a formatter handles.",
    },
    "security-reviewer": {
      command: "claude",
      systemPrompt: "You are an expert application security auditor. You have deep knowledge of OWASP Top 10, CWE classifications, secure coding practices, and threat modeling. You read the actual files in the working directory to trace data flows and understand attack surfaces. You produce structured findings with severity ratings and concrete remediation steps. Focus on exploitable vulnerabilities and real risks — not theoretical concerns with no feasible attack path.",
    },
    "rules-reviewer": {
      command: "claude",
      systemPrompt: "You are an expert at enforcing project conventions and coding standards. You thoroughly read all project configuration and convention files (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, lint configs, tsconfig, .editorconfig, etc.) before reviewing. You verify code changes adhere to every stated rule. You flag specific deviations with exact references to the rule source. If no project rules exist, you review against widely-accepted community standards for the language/framework in use.",
    },
    "synthesizer": {
      command: "claude",
      systemPrompt: "You are a senior engineering lead who synthesizes multiple code review perspectives into a single, coherent review. You deduplicate findings across lenses, resolve any conflicts between reviewers, assign final severity levels, and produce a clear, well-organized review document. Your output must be structured with INLINE COMMENTS and SUMMARY sections, ready to post as a PR review. Keep output under 3000 words.",
    },
  },

  guardrails: {
    maxIterations: 3,
    post: [
      { check: "output.trim().length > 100", reason: "reviewer output is too short — must contain substantive findings or an explicit clean bill" },
    ],
  },
}
