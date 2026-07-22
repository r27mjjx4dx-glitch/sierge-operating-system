import type { Plan, ValidationReport, FileChange } from "../../shared/types.js";

export const PLAN_TEMPLATE_HEADINGS = [
  "## Outcome",
  "## Assumptions",
  "## Affected areas",
  "## Acceptance criteria",
  "## Steps",
] as const;

export function buildPlanPrompt(
  contextBundle: string,
  ownerRequest: string,
): string {
  return `You are planning a change for a non-technical product owner. Explore the
project as needed (read-only), then produce a plan the owner can understand
and approve. If — and only if — something essential is ambiguous, ask via
your question tool; otherwise state a reasonable assumption.

=== PROJECT CONTEXT (owner-maintained; treat as authoritative) ===
${contextBundle}
=== END PROJECT CONTEXT ===

=== OWNER REQUEST ===
${ownerRequest}
=== END OWNER REQUEST ===

Write your final message as EXACTLY this markdown template, in plain,
non-technical language (name files only under "Affected areas"):

## Outcome
One or two sentences: what the owner will be able to see or do afterwards.

## Assumptions
- Bullet list of assumptions you are making (or "None").

## Affected areas
- Bullet list of the parts of the product this touches, each with a short plain-language note.

## Acceptance criteria
- Bullet list of specific, checkable statements the owner can verify.

## Steps
1. Numbered implementation steps, each one plain sentence.`;
}

export function buildImplementPrompt(plan: Plan): string {
  return `The owner has APPROVED the plan below. Implement it exactly — the plan is
your contract. Do not expand scope. Commit your work as you go with clear
messages. If a step turns out to be impossible, finish what you can and
explain plainly what is missing and why.

=== APPROVED PLAN ===
${plan.markdown}
=== END APPROVED PLAN ===`;
}

export function buildFixPrompt(report: ValidationReport): string {
  const failing = report.checks
    .filter((c) => c.status === "failed")
    .map(
      (c) =>
        `- ${c.name} (command: ${c.command ?? "?"}, exit code ${c.exitCode ?? "?"}):\n${c.logTail ?? "(no output captured)"}`,
    )
    .join("\n");
  return `Sierge ran the project's checks after your implementation and some FAILED.
Fix the failures, then commit. Do not weaken or delete checks to make them
pass — fix the underlying problem. The failing checks:

${failing}`;
}

export function buildSummarizePrompt(
  plan: Plan | null,
  changedFiles: FileChange[],
): string {
  const criteria =
    plan?.sections.acceptanceCriteria?.map((c) => `- ${c}`).join("\n") ??
    "(no structured criteria — summarize against the plan text)";
  const files = changedFiles.map((f) => `- ${f.changeType}: ${f.path}`).join("\n");
  return `The implementation session has ended. Produce a review summary for the
non-technical owner. Respond with EXACTLY this markdown template:

## What changed
One short paragraph in plain language.

## Changed files
For each file below, one line: \`path\` — plain-language description of what
changed there and why it matters to the product.
${files || "(no files changed)"}

## Acceptance criteria check
For each criterion below, one line starting with "Met:", "Not met:" or
"Unverified:" followed by the criterion and a short plain-language note.
Only write "Met:" if you have direct evidence from this session.
${criteria}

## Limitations and next steps
Bullet list of anything incomplete, risky, or recommended next (or "None").`;
}
