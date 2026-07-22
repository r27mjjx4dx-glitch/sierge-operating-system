import { useEffect, useRef, useState } from "react";
import type { PlanSections, Task } from "../../shared/types";
import * as api from "../api";
import { btn, Card, ErrorNote, textareaClass } from "../ui";

export function PlanPanel({ task }: { task: Task }) {
  const plan = task.plan;
  const [markdown, setMarkdown] = useState(plan?.markdown ?? "");
  const editorVersionRef = useRef<number | null>(plan?.version ?? null);
  const [busy, setBusy] = useState<"approve" | "replan" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // When a NEW plan version arrives (e.g. after a re-plan), load it into the
  // editor. Snapshots of the same version never clobber the owner's edits.
  useEffect(() => {
    if (plan && plan.version !== editorVersionRef.current) {
      editorVersionRef.current = plan.version;
      setMarkdown(plan.markdown);
    }
  }, [plan]);

  const run = async (which: "approve" | "replan" | "discard", fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    try {
      await fn();
      // The task snapshot over SSE moves the screen forward.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "That didn't work — please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <Card>
      <h2 className="text-lg font-semibold text-slate-900">
        Here's the plan — approve it or edit it first.
      </h2>
      <p className="mt-1 text-sm text-slate-500">
        Nothing gets built until you approve. You can change the words below before you do.
      </p>

      {plan ? <PlanSectionsPreview sections={plan.sections} /> : null}

      <div className="mt-5">
        <label htmlFor="plan-editor" className="mb-1 block text-sm font-medium text-slate-700">
          The plan, in Claude's words
        </label>
        <textarea
          id="plan-editor"
          className={`${textareaClass} font-mono text-xs`}
          rows={14}
          value={markdown}
          onChange={(event) => setMarkdown(event.target.value)}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btn.green}
          disabled={busy !== null || !markdown.trim()}
          onClick={() => void run("approve", () => api.approvePlan(task.id, markdown))}
        >
          {busy === "approve" ? "Approving…" : "Approve plan"}
        </button>
        <button
          type="button"
          className={btn.subtle}
          disabled={busy !== null}
          onClick={() => void run("replan", () => api.startPlan(task.id))}
        >
          {busy === "replan" ? "Asking…" : "Ask Claude to re-plan"}
        </button>
        <button
          type="button"
          className={btn.dangerOutline}
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm("This permanently throws the plan away. Are you sure?")) {
              void run("discard", () => api.discardTask(task.id));
            }
          }}
        >
          {busy === "discard" ? "Discarding…" : "Discard"}
        </button>
      </div>
      <ErrorNote message={error} />
    </Card>
  );
}

function PlanSectionsPreview({ sections }: { sections: PlanSections }) {
  const { outcome, assumptions, affectedAreas, acceptanceCriteria, steps } = sections;
  const hasAny =
    Boolean(outcome) ||
    Boolean(assumptions?.length) ||
    Boolean(affectedAreas?.length) ||
    Boolean(acceptanceCriteria?.length) ||
    Boolean(steps?.length);
  if (!hasAny) return null;

  return (
    <div className="mt-5 space-y-4">
      {outcome ? (
        <div className="rounded-lg border border-indigo-200 bg-indigo-50 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-indigo-700">
            What you'll get
          </p>
          <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-800">{outcome}</p>
        </div>
      ) : null}

      {assumptions && assumptions.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            What Claude is assuming
          </p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-sm text-slate-700">
            {assumptions.map((item, i) => (
              <li key={i}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {affectedAreas && affectedAreas.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Parts of the project this touches
          </p>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {affectedAreas.map((area, i) => (
              <li
                key={i}
                className="rounded-full bg-slate-100 px-2.5 py-0.5 text-xs text-slate-600"
              >
                {area}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {acceptanceCriteria && acceptanceCriteria.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            How we'll know it worked
          </p>
          <ul className="mt-1 space-y-1">
            {acceptanceCriteria.map((item, i) => (
              <li key={i} className="flex items-start gap-2 text-sm text-slate-700">
                <span aria-hidden="true" className="mt-0.5 text-slate-400">
                  ☐
                </span>
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      {steps && steps.length > 0 ? (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Steps</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-700">
            {steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        </div>
      ) : null}
    </div>
  );
}
