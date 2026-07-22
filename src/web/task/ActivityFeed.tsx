import { useMemo, useState } from "react";
import type { ReactNode } from "react";
import type {
  AssistantTextEvent,
  TaskEvent,
  TaskStatus,
  ValidationCheck,
} from "../../shared/types";
import { relativeTime } from "../ui";

// --- Feed model -------------------------------------------------------------

type FeedItem =
  | { kind: "text"; id: string; ts: string; phase: AssistantTextEvent["phase"]; text: string }
  | { kind: "event"; event: Exclude<TaskEvent, AssistantTextEvent> };

function buildFeedItems(events: TaskEvent[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const event of events) {
    if (event.type === "assistant_text") {
      const last = items[items.length - 1];
      if (last && last.kind === "text" && last.phase === event.phase) {
        last.text += event.delta;
      } else {
        items.push({ kind: "text", id: event.id, ts: event.ts, phase: event.phase, text: event.delta });
      }
      continue;
    }
    if (event.type === "policy_decision") {
      const blocked =
        event.decision === "deny" ||
        event.decision === "ask_deny" ||
        event.decision === "ask_timeout_deny";
      const ownerDecided = event.decidedBy === "owner";
      if (!blocked && !ownerDecided) continue; // routine allows stay quiet
    }
    items.push({ kind: "event", event });
  }
  return items;
}

const COLLAPSED_COUNT = 8;

export function ActivityFeed({ events }: { events: TaskEvent[] }) {
  const [showAll, setShowAll] = useState(false);
  const items = useMemo(() => buildFeedItems(events), [events]);
  const visible = showAll ? items : items.slice(-COLLAPSED_COUNT);
  const hiddenCount = items.length - visible.length;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-900">Activity</h2>
        {showAll && items.length > COLLAPSED_COUNT ? (
          <button
            type="button"
            className="text-sm text-indigo-600 hover:underline"
            onClick={() => setShowAll(false)}
          >
            Show recent only
          </button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">Nothing has happened yet.</p>
      ) : (
        <>
          {hiddenCount > 0 ? (
            <button
              type="button"
              className="mt-3 text-sm text-indigo-600 hover:underline"
              onClick={() => setShowAll(true)}
            >
              Show all ({items.length} items)
            </button>
          ) : null}
          <ol className="mt-3 space-y-2">
            {visible.map((item) =>
              item.kind === "text" ? (
                <AssistantTextItem key={item.id} item={item} />
              ) : (
                <EventItem key={item.event.id} event={item.event} />
              ),
            )}
          </ol>
        </>
      )}
    </section>
  );
}

// --- Rendering --------------------------------------------------------------

const PHASE_LABEL: Record<AssistantTextEvent["phase"], string> = {
  plan: "Claude, while planning",
  implement: "Claude, while building",
  summarize: "Claude, summing up",
};

function AssistantTextItem({ item }: { item: Extract<FeedItem, { kind: "text" }> }) {
  return (
    <li className="rounded-lg bg-slate-50 p-3">
      <FeedMeta label={PHASE_LABEL[item.phase]} ts={item.ts} />
      <p className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
        {item.text}
      </p>
    </li>
  );
}

function FeedMeta({ label, ts }: { label: string; ts: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-xs font-medium text-slate-400">{label}</span>
      <span className="shrink-0 text-xs text-slate-400">{relativeTime(ts)}</span>
    </div>
  );
}

function FeedLine({
  ts,
  tone = "neutral",
  children,
}: {
  ts: string;
  tone?: "neutral" | "grey" | "red" | "amber" | "info";
  children: ReactNode;
}) {
  const toneClass: Record<string, string> = {
    neutral: "text-slate-700",
    grey: "text-slate-500",
    red: "text-red-700",
    amber: "text-amber-700",
    info: "text-slate-600",
  };
  return (
    <li className="flex items-baseline justify-between gap-3 py-0.5">
      <span className={`min-w-0 text-sm ${toneClass[tone] ?? "text-slate-700"}`}>{children}</span>
      <span className="shrink-0 text-xs text-slate-400">{relativeTime(ts)}</span>
    </li>
  );
}

const STATE_CHANGE_LABEL: Record<TaskStatus, string> = {
  draft: "Change created",
  planning: "Planning started",
  plan_ready: "Plan ready — waiting for your approval",
  implementing: "Building started",
  validating: "Checks running",
  review: "Ready for your review",
  accepted: "Changes accepted",
  discarded: "Work discarded",
  failed: "Stopped — something went wrong",
};

const OWNER_ACTION_LABEL: Record<string, string> = {
  request_created: "You asked for this change",
  plan_approved: "You approved the plan",
  plan_edited: "You edited the plan",
  accepted: "You accepted the changes",
  discarded: "You discarded this work",
  changes_requested: "You asked for changes",
};

const CHECK_STATUS_LABEL: Record<ValidationCheck["status"], string> = {
  passed: "passed",
  failed: "failed",
  unavailable: "not available in this project",
  skipped: "skipped",
};

function EventItem({ event }: { event: Exclude<TaskEvent, AssistantTextEvent> }) {
  switch (event.type) {
    case "state_change":
      return (
        <li className="flex items-center gap-3 py-1.5">
          <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
          <span className="text-xs font-medium uppercase tracking-wide text-slate-400">
            {STATE_CHANGE_LABEL[event.to]}
          </span>
          <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
          <span className="shrink-0 text-xs text-slate-400">{relativeTime(event.ts)}</span>
        </li>
      );

    case "tool_attempt":
      return (
        <li className="py-0.5">
          <div className="flex items-baseline justify-between gap-3">
            <span className="min-w-0 text-sm text-slate-700">{event.plainSummary}</span>
            <span className="shrink-0 text-xs text-slate-400">{relativeTime(event.ts)}</span>
          </div>
          <details className="mt-0.5">
            <summary className="text-xs text-slate-400 hover:text-slate-600">
              Show technical detail
            </summary>
            <pre className="mt-1 overflow-x-auto rounded bg-slate-100 p-2 font-mono text-xs text-slate-600">
              {event.inputSummary}
            </pre>
          </details>
        </li>
      );

    case "policy_decision": {
      const blocked =
        event.decision === "deny" ||
        event.decision === "ask_deny" ||
        event.decision === "ask_timeout_deny";
      if (blocked) {
        return (
          <li className="flex items-baseline justify-between gap-3 rounded-lg bg-red-50 px-3 py-1.5">
            <span className="min-w-0 text-sm text-red-700">Blocked: {event.plainSummary}</span>
            <span className="shrink-0 text-xs text-red-400">{relativeTime(event.ts)}</span>
          </li>
        );
      }
      // Owner-approved decision.
      return (
        <FeedLine ts={event.ts} tone="grey">
          You allowed this: {event.plainSummary}
        </FeedLine>
      );
    }

    case "approval_request":
      return (
        <FeedLine ts={event.ts} tone="grey">
          Sierge asked you: {event.title}
        </FeedLine>
      );

    case "approval_resolved": {
      let text: string;
      if (event.resolution === "timeout") {
        text = "Time ran out, so Sierge answered no for you.";
      } else if (event.resolution === "denied") {
        text = "You said no.";
      } else if (event.answer) {
        text = `You answered: ${event.answer}`;
      } else {
        text = "You said yes.";
      }
      return (
        <FeedLine ts={event.ts} tone="grey">
          {text}
        </FeedLine>
      );
    }

    case "owner_action":
      return (
        <FeedLine ts={event.ts} tone="grey">
          {OWNER_ACTION_LABEL[event.action] ?? event.action}
          {event.detail ? ` — ${event.detail}` : ""}
        </FeedLine>
      );

    case "validation":
      return (
        <li className="rounded-lg bg-slate-50 p-3">
          <FeedMeta label="Checks" ts={event.ts} />
          <ul className="mt-1 space-y-0.5">
            {event.report.checks.map((check) => (
              <li key={check.name} className="text-sm text-slate-700">
                <span className="font-medium">{check.name}</span>: {CHECK_STATUS_LABEL[check.status]}
              </li>
            ))}
          </ul>
        </li>
      );

    case "system_note": {
      const tone = event.level === "error" ? "red" : event.level === "warn" ? "amber" : "info";
      return (
        <FeedLine ts={event.ts} tone={tone}>
          {event.text}
        </FeedLine>
      );
    }
  }
}
