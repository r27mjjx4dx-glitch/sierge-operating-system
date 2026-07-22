import { useEffect, useMemo, useState } from "react";
import type {
  FileChange,
  PreviewState,
  Task,
  ValidationCheck,
  ValidationReport,
} from "../../shared/types";
import * as api from "../api";
import { btn, Card, ErrorNote, formatDuration, MarkdownLite, Spinner, textareaClass } from "../ui";

// ---------------------------------------------------------------------------
// Markdown section helpers
// ---------------------------------------------------------------------------

function extractSection(markdown: string, titleMatches: (title: string) => boolean): string | null {
  const lines = markdown.split("\n");
  let found = false;
  const out: string[] = [];
  for (const line of lines) {
    const heading = /^##\s+(.*)$/.exec(line);
    if (heading) {
      if (found) break;
      if (titleMatches((heading[1] ?? "").trim().toLowerCase())) found = true;
      continue;
    }
    if (found) out.push(line);
  }
  return found ? out.join("\n").trim() : null;
}

type CriterionStatus = "met" | "not_met" | "unverified";

interface CriterionRow {
  status: CriterionStatus;
  text: string;
}

function parseCriteria(sectionBody: string): CriterionRow[] | null {
  const rows: CriterionRow[] = [];
  for (const raw of sectionBody.split("\n")) {
    const line = raw
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^\d+[.)]\s+/, "");
    const match = /^(Met|Not met|Unverified)\s*:\s*(.*)$/i.exec(line);
    if (!match) continue;
    const label = (match[1] ?? "").toLowerCase();
    const status: CriterionStatus =
      label === "met" ? "met" : label === "not met" ? "not_met" : "unverified";
    rows.push({ status, text: match[2] ?? "" });
  }
  return rows.length > 0 ? rows : null;
}

// ---------------------------------------------------------------------------
// Review panel
// ---------------------------------------------------------------------------

export function ReviewPanel({ task }: { task: Task }) {
  const review = task.review;

  const summary = review?.summaryMarkdown ?? null;
  const criteriaSection = useMemo(
    () => (summary ? extractSection(summary, (t) => t.includes("acceptance criteria")) : null),
    [summary],
  );
  const criteriaRows = useMemo(
    () => (criteriaSection ? parseCriteria(criteriaSection) : null),
    [criteriaSection],
  );
  const whatChangedSection = useMemo(
    () => (summary ? extractSection(summary, (t) => t.includes("what changed")) : null),
    [summary],
  );

  if (!review) {
    return (
      <Card>
        <Spinner label="Putting the review together…" />
      </Card>
    );
  }

  return (
    <div className="space-y-5">
      <Card>
        <h2 className="text-lg font-semibold text-slate-900">Review the result</h2>
        <p className="mt-1 text-sm text-slate-500">
          Nothing is part of your project yet. Look things over, try the preview, then decide at the
          bottom of the page.
        </p>
      </Card>

      {review.caveats.length > 0 ? (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-5">
          <h3 className="font-semibold text-amber-900">Read this first</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-amber-800">
            {review.caveats.map((caveat, i) => (
              <li key={i}>{caveat}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <Card>
        <h3 className="text-base font-semibold text-slate-900">Did it do what you asked?</h3>
        {criteriaRows ? (
          <ul className="mt-3 space-y-2">
            {criteriaRows.map((row, i) => (
              <CriterionLine key={i} row={row} />
            ))}
          </ul>
        ) : criteriaSection ? (
          <div className="mt-3">
            <MarkdownLite text={criteriaSection} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">
            Claude didn't report against the plan's checklist for this change.
          </p>
        )}
      </Card>

      <Card>
        <h3 className="text-base font-semibold text-slate-900">What changed</h3>
        {whatChangedSection ? (
          <div className="mt-3">
            <MarkdownLite text={whatChangedSection} />
          </div>
        ) : summary ? (
          <div className="mt-3">
            <MarkdownLite text={summary} />
          </div>
        ) : (
          <p className="mt-3 text-sm text-slate-500">Claude didn't leave a written summary.</p>
        )}
        {review.changedFiles.length > 0 ? (
          <ul className="mt-4 space-y-2 border-t border-slate-100 pt-4">
            {review.changedFiles.map((file) => (
              <ChangedFileLine key={file.path} file={file} />
            ))}
          </ul>
        ) : null}
        {review.diffStat ? (
          <p className="mt-3 font-mono text-xs text-slate-400">{review.diffStat}</p>
        ) : null}
      </Card>

      <Card>
        <h3 className="text-base font-semibold text-slate-900">What the checks say</h3>
        <ValidationEvidence report={review.validation ?? task.validation} />
      </Card>

      <PreviewPanel taskId={task.id} />
    </div>
  );
}

function CriterionLine({ row }: { row: CriterionRow }) {
  const icon =
    row.status === "met" ? (
      <span aria-hidden="true" className="mt-0.5 font-semibold text-green-600">✓</span>
    ) : row.status === "not_met" ? (
      <span aria-hidden="true" className="mt-0.5 font-semibold text-red-600">✕</span>
    ) : (
      <span aria-hidden="true" className="mt-0.5 font-semibold text-slate-400">?</span>
    );
  const srLabel =
    row.status === "met" ? "Met" : row.status === "not_met" ? "Not met" : "Not verified";
  return (
    <li className="flex items-start gap-2 text-sm text-slate-700">
      {icon}
      <span>
        <span className="sr-only">{srLabel}: </span>
        {row.text}
      </span>
    </li>
  );
}

const CHANGE_TYPE_CHIP: Record<FileChange["changeType"], { label: string; className: string }> = {
  added: { label: "New", className: "bg-green-100 text-green-700" },
  modified: { label: "Changed", className: "bg-blue-100 text-blue-700" },
  deleted: { label: "Removed", className: "bg-red-100 text-red-700" },
  renamed: { label: "Renamed", className: "bg-amber-100 text-amber-800" },
};

function ChangedFileLine({ file }: { file: FileChange }) {
  const chip = CHANGE_TYPE_CHIP[file.changeType];
  return (
    <li className="flex items-start gap-3">
      <span
        className={`mt-0.5 shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium ${chip.className}`}
      >
        {chip.label}
      </span>
      <div className="min-w-0">
        <p className="break-all font-mono text-xs text-slate-500">{file.path}</p>
        {file.plainDescription ? (
          <p className="mt-0.5 text-sm text-slate-700">{file.plainDescription}</p>
        ) : null}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Validation evidence
// ---------------------------------------------------------------------------

const CHECK_PILL: Record<ValidationCheck["status"], { label: string; className: string }> = {
  passed: { label: "Passed", className: "bg-green-100 text-green-700" },
  failed: { label: "Failed", className: "bg-red-100 text-red-700" },
  unavailable: { label: "No such check in this project", className: "bg-slate-100 text-slate-500" },
  skipped: { label: "Skipped", className: "bg-slate-100 text-slate-500" },
};

function overallBanner(report: ValidationReport | null) {
  if (!report || report.overall === "none") {
    return {
      className: "border-slate-200 bg-slate-100 text-slate-600",
      text: "This project has no automatic checks; nothing was verified automatically.",
    };
  }
  if (report.overall === "passed") {
    return {
      className: "border-green-200 bg-green-50 text-green-800",
      text: "All available checks passed.",
    };
  }
  if (report.overall === "failed") {
    return {
      className: "border-red-200 bg-red-50 text-red-800",
      text: "Some checks failed — this work is not finished.",
    };
  }
  // partial
  return {
    className: "border-amber-200 bg-amber-50 text-amber-800",
    text: "Some checks couldn't be run, so not everything was verified.",
  };
}

function ValidationEvidence({ report }: { report: ValidationReport | null }) {
  const banner = overallBanner(report);
  return (
    <div className="mt-3 space-y-3">
      <div className={`rounded-lg border p-3 text-sm font-medium ${banner.className}`}>
        {banner.text}
      </div>
      {report && report.checks.length > 0 ? (
        <ul className="space-y-2">
          {report.checks.map((check) => (
            <li key={check.name} className="rounded-lg border border-slate-200 p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-medium text-slate-800">{check.name}</span>
                <span
                  className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${CHECK_PILL[check.status].className}`}
                >
                  {CHECK_PILL[check.status].label}
                </span>
                {check.durationMs !== null ? (
                  <span className="text-xs text-slate-400">{formatDuration(check.durationMs)}</span>
                ) : null}
              </div>
              {check.logTail ? (
                <details className="mt-2">
                  <summary className="text-xs text-slate-400 hover:text-slate-600">
                    Show what the check printed
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded-lg bg-slate-900 p-3 font-mono text-xs leading-relaxed text-slate-100">
                    {check.logTail}
                  </pre>
                </details>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Preview panel
// ---------------------------------------------------------------------------

function PreviewPanel({ taskId }: { taskId: string }) {
  const [state, setState] = useState<PreviewState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api
      .getPreview(taskId)
      .then((s) => {
        if (!cancelled) setState(s);
      })
      .catch(() => {
        // Leave as unknown; the Start button will surface any real error.
      });
    return () => {
      cancelled = true;
    };
  }, [taskId]);

  // While the preview is starting, check in until it's ready or has failed.
  useEffect(() => {
    if (state?.status !== "starting") return;
    const timer = window.setInterval(() => {
      api
        .getPreview(taskId)
        .then(setState)
        .catch(() => {});
    }, 1500);
    return () => window.clearInterval(timer);
  }, [state?.status, taskId]);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.startPreview(taskId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't start the preview.");
    } finally {
      setBusy(false);
    }
  };

  const stop = async () => {
    setBusy(true);
    setError(null);
    try {
      setState(await api.stopPreview(taskId));
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't stop the preview.");
    } finally {
      setBusy(false);
    }
  };

  const status = state?.status ?? "stopped";

  return (
    <Card>
      <h3 className="text-base font-semibold text-slate-900">Try it before you decide</h3>
      <div className="mt-3">
        {status === "stopped" ? (
          <div>
            <p className="text-sm text-slate-500">
              Sierge can run this version of your project so you can see it in your browser.
            </p>
            <button
              type="button"
              className={`${btn.primary} mt-3`}
              onClick={() => void start()}
              disabled={busy}
            >
              {busy ? "Starting…" : "Start preview"}
            </button>
          </div>
        ) : null}

        {status === "starting" ? <Spinner label="Starting…" /> : null}

        {status === "ready" && state?.url ? (
          <div className="flex flex-wrap items-center gap-4">
            <a
              href={state.url}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-indigo-600 px-5 py-3 text-base font-medium text-white shadow-sm hover:bg-indigo-700"
            >
              Open the preview
              <span aria-hidden="true">↗</span>
            </a>
            <button type="button" className={btn.subtle} onClick={() => void stop()} disabled={busy}>
              {busy ? "Stopping…" : "Stop preview"}
            </button>
          </div>
        ) : null}

        {status === "failed" ? (
          <div>
            <p className="text-sm text-red-600">
              The preview couldn't start.
              {state?.detail ? ` ${state.detail}` : ""}
            </p>
            <button
              type="button"
              className={`${btn.subtle} mt-3`}
              onClick={() => void start()}
              disabled={busy}
            >
              Try again
            </button>
          </div>
        ) : null}

        {status === "unavailable" ? (
          <p className="text-sm text-slate-500">
            {state?.detail ?? "This project doesn't have a preview Sierge knows how to run."}
          </p>
        ) : null}

        <ErrorNote message={error} />
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Decision bar (sticky, rendered at the bottom of the task screen)
// ---------------------------------------------------------------------------

export function DecisionBar({ taskId }: { taskId: string }) {
  const [busy, setBusy] = useState<"accept" | "request" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFeedback, setShowFeedback] = useState(false);
  const [feedback, setFeedback] = useState("");

  const run = async (which: "accept" | "request" | "discard", fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    try {
      await fn();
      // The SSE snapshot moves the screen on from here.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "That didn't work — please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="sticky bottom-0 z-20 -mx-1 rounded-t-xl border border-slate-200 bg-white p-4 shadow-[0_-4px_12px_rgba(15,23,42,0.06)]">
      {showFeedback ? (
        <div className="mb-3">
          <label htmlFor="review-feedback" className="mb-1 block text-sm font-medium text-slate-700">
            What should be different?
          </label>
          <textarea
            id="review-feedback"
            className={textareaClass}
            rows={3}
            value={feedback}
            onChange={(event) => setFeedback(event.target.value)}
            placeholder="Tell Claude what to change, in your own words"
          />
          <div className="mt-2 flex items-center gap-3">
            <button
              type="button"
              className={btn.primary}
              disabled={busy !== null || !feedback.trim()}
              onClick={() => void run("request", () => api.requestChanges(taskId, feedback.trim()))}
            >
              {busy === "request" ? "Sending…" : "Send to Claude"}
            </button>
            <button
              type="button"
              className={btn.subtle}
              disabled={busy !== null}
              onClick={() => setShowFeedback(false)}
            >
              Never mind
            </button>
          </div>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          className={btn.green}
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm("This will make the changes part of your project. Continue?")) {
              void run("accept", () => api.acceptTask(taskId));
            }
          }}
        >
          {busy === "accept" ? "Accepting…" : "Accept these changes"}
        </button>
        <button
          type="button"
          className={btn.subtle}
          disabled={busy !== null}
          onClick={() => setShowFeedback((s) => !s)}
        >
          Request changes
        </button>
        <button
          type="button"
          className={btn.dangerOutline}
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm("This permanently throws the work away. Are you sure?")) {
              void run("discard", () => api.discardTask(taskId));
            }
          }}
        >
          {busy === "discard" ? "Discarding…" : "Discard"}
        </button>
      </div>
      <ErrorNote message={error} />
    </div>
  );
}
