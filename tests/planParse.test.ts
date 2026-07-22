import { describe, expect, it } from "vitest";
import {
  extractFileDescriptions,
  parsePlanSections,
} from "../src/server/agent/planParse.js";

const SAMPLE = `## Outcome
Visitors can submit an intake form.

## Assumptions
- The form does not need file uploads.
- English only for now.

## Affected areas
- Contact page — gains the new form.

## Acceptance criteria
- Submitting the form shows a confirmation message.
- Empty required fields show a friendly error.

## Steps
1. Create the form component.
2. Wire it to the page.
`;

describe("parsePlanSections", () => {
  it("parses all template sections", () => {
    const s = parsePlanSections(SAMPLE);
    expect(s.outcome).toContain("intake form");
    expect(s.assumptions).toHaveLength(2);
    expect(s.affectedAreas).toHaveLength(1);
    expect(s.acceptanceCriteria).toHaveLength(2);
    expect(s.steps).toHaveLength(2);
  });

  it("degrades gracefully on non-template text", () => {
    const s = parsePlanSections("Just some freeform plan text.");
    expect(s.outcome).toBeUndefined();
    expect(s.acceptanceCriteria).toBeUndefined();
  });
});

describe("extractFileDescriptions", () => {
  it("maps backticked paths to descriptions", () => {
    const md = `## Changed files
- \`src/Form.tsx\` — The new intake form itself.
- \`src/App.tsx\` - Shows the form on the contact page.
`;
    const m = extractFileDescriptions(md);
    expect(m.get("src/Form.tsx")).toContain("intake form");
    expect(m.get("src/App.tsx")).toContain("contact page");
  });
});
