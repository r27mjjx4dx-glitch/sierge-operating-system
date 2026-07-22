import { useState } from "react";
import type { Task } from "../../shared/types";
import * as api from "../api";
import { btn, Card, ErrorNote, MarkdownLite, Spinner } from "../ui";

// --- Draft / planning -------------------------------------------------------

export function PlanningPanel({ task, planStream }: { task: Task; planStream: string }) {
  const [nudging, setNudging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nudge = async () => {
    setNudging(true);
    setError(null);
    try {
      await api.startPlan(task.id);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't start planning.");
    } finally {
      setNudging(false);
    }
  };

  return (
    <Card>
      <div className="flex items-center gap-3">
        <Spinner />
        <h2 className="text-lg font-semibold text-slate-900">
          Claude is reading your project and writing a plan…
        </h2>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        This usually takes a minute or two. You'll get to approve the plan before anything is built.
      </p>
      {task.status === "draft" ? (
        <div className="mt-3">
          <button type="button" className={btn.subtle} onClick={() => void nudge()} disabled={nudging}>
            {nudging ? "Starting…" : "Start planning"}
          </button>
          <ErrorNote message={error} />
        </div>
      ) : null}
      {planStream.trim() ? (
        <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 p-4">
          <MarkdownLite text={planStream} />
        </div>
      ) : null}
    </Card>
  );
}

// --- Implementing / validating ----------------------------------------------

export function BuildingPanel({ validating }: { validating: boolean }) {
  return (
    <Card>
      <div className="flex items-center gap-3">
        <Spinner />
        <h2 className="text-lg font-semibold text-slate-900">
          {validating ? "Sierge is running the project's checks" : "Claude is building…"}
        </h2>
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {validating
          ? "Claude doesn't grade its own work — Sierge runs the checks independently."
          : "You can watch below. If Claude needs anything from you, a question will appear here."}
      </p>
    </Card>
  );
}

// --- Failed -----------------------------------------------------------------

export function FailedPanel({ task }: { task: Task }) {
  const [busy, setBusy] = useState<"retry" | "discard" | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Only a task whose plan the owner actually approved may resume
  // implementation; a planning failure must write a fresh plan (which now
  // works from a failed task). This matches the server's approval gate.
  const canContinue = task.planApproved;

  const run = async (which: "retry" | "discard", fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(which);
    setError(null);
    try {
      await fn();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "That didn't work — please try again.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="rounded-xl border border-red-200 bg-red-50 p-5">
      <h2 className="text-lg font-semibold text-red-800">Something went wrong</h2>
      <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-red-700">
        {task.failureReason ?? "Claude couldn't finish this work. Nothing in your project was changed."}
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        {canContinue ? (
          <button
            type="button"
            className={btn.primary}
            disabled={busy !== null}
            onClick={() =>
              void run("retry", () =>
                api.requestChanges(task.id, "Please continue and complete the previous plan."),
              )
            }
          >
            {busy === "retry" ? "Asking…" : "Try again"}
          </button>
        ) : (
          <button
            type="button"
            className={btn.primary}
            disabled={busy !== null}
            onClick={() => void run("retry", () => api.startPlan(task.id))}
          >
            {busy === "retry" ? "Asking…" : "Write a new plan"}
          </button>
        )}
        <button
          type="button"
          className={btn.dangerOutline}
          disabled={busy !== null}
          onClick={() => {
            if (window.confirm("This permanently throws the work away. Are you sure?")) {
              void run("discard", () => api.discardTask(task.id));
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

// --- Accepted / discarded ---------------------------------------------------

export function AcceptedPanel({ task }: { task: Task }) {
  return (
    <div className="rounded-xl border border-green-200 bg-green-50 p-5">
      <h2 className="text-lg font-semibold text-green-800">
        These changes are now part of your project.
      </h2>
      <p className="mt-1 text-sm text-green-700">Nice work — this change is done.</p>
      <a
        href={`#/project/${encodeURIComponent(task.projectId)}`}
        className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline"
      >
        Back to the project
      </a>
    </div>
  );
}

export function DiscardedPanel({ task }: { task: Task }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-slate-100 p-5">
      <h2 className="text-lg font-semibold text-slate-700">This work was discarded.</h2>
      <p className="mt-1 text-sm text-slate-500">
        Nothing in your project was changed. You can ask for a new change any time.
      </p>
      <a
        href={`#/project/${encodeURIComponent(task.projectId)}`}
        className="mt-3 inline-block text-sm font-medium text-indigo-600 hover:underline"
      >
        Back to the project
      </a>
    </div>
  );
}
