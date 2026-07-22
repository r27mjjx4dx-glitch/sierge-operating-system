import type { Plan, PlanSections } from "../../shared/types.js";

/**
 * Best-effort parsing of the plan template into structured sections. The raw
 * markdown is ALWAYS the source of truth — a parse failure degrades to raw
 * display, it never blocks the pipeline (ADR-0002).
 */

function sectionBody(markdown: string, heading: string): string | null {
  const re = new RegExp(
    `^##\\s+${heading}\\s*$([\\s\\S]*?)(?=^##\\s+|$(?![\\s\\S]))`,
    "im",
  );
  const m = markdown.match(re);
  return m?.[1]?.trim() ?? null;
}

function bullets(body: string | null): string[] | undefined {
  if (!body) return undefined;
  const items = body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^(-|\*|\d+[.)])\s+/.test(l))
    .map((l) => l.replace(/^(-|\*|\d+[.)])\s+/, "").trim())
    .filter(Boolean);
  return items.length > 0 ? items : undefined;
}

export function parsePlanSections(markdown: string): PlanSections {
  return {
    outcome: sectionBody(markdown, "Outcome") ?? undefined,
    assumptions: bullets(sectionBody(markdown, "Assumptions")),
    affectedAreas: bullets(sectionBody(markdown, "Affected areas")),
    acceptanceCriteria: bullets(sectionBody(markdown, "Acceptance criteria")),
    steps: bullets(sectionBody(markdown, "Steps")),
  };
}

export function makePlan(
  markdown: string,
  version: number,
  editedByOwner: boolean,
): Plan {
  return {
    version,
    markdown,
    sections: parsePlanSections(markdown),
    editedByOwner,
    createdAt: new Date().toISOString(),
  };
}

/** Pull per-file plain descriptions out of the review summary, best-effort. */
export function extractFileDescriptions(
  summaryMarkdown: string,
): Map<string, string> {
  const out = new Map<string, string>();
  const body = sectionBody(summaryMarkdown, "Changed files");
  if (!body) return out;
  for (const line of body.split("\n")) {
    const m = line.match(/`([^`]+)`\s*[—-]\s*(.+)$/);
    if (m && m[1] && m[2]) {
      out.set(m[1].trim().replace(/\\/g, "/"), m[2].trim());
    }
  }
  return out;
}
