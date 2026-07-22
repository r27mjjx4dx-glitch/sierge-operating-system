import { useState } from "react";
import type { ApprovalRequestEvent } from "../../shared/types";
import * as api from "../api";
import { btn, ErrorNote, textareaClass } from "../ui";

export function ApprovalCard({
  taskId,
  approval,
}: {
  taskId: string;
  approval: ApprovalRequestEvent;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [freeText, setFreeText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolve = async (decision: "approve" | "deny", answer?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.resolveApproval(
        taskId,
        approval.approvalId,
        answer !== undefined ? { decision, answer } : { decision },
      );
      // The card disappears when the approval_resolved event arrives over SSE.
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Couldn't send your answer.");
      setBusy(false);
    }
  };

  const toggleOption = (option: string) => {
    if (approval.multiSelect) {
      setSelected((prev) =>
        prev.includes(option) ? prev.filter((o) => o !== option) : [...prev, option],
      );
    } else {
      setSelected([option]);
    }
  };

  const submitAnswer = () => {
    const parts = [...selected];
    const extra = freeText.trim();
    if (extra) parts.push(extra);
    if (parts.length === 0) return;
    void resolve("approve", parts.join("; "));
  };

  const hasOptions = approval.options !== null && approval.options.length > 0;

  return (
    <div className="rounded-xl border-2 border-amber-300 bg-amber-50 p-5 shadow-sm">
      <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">
        Claude needs your answer
      </p>
      <h3 className="mt-1 text-base font-semibold text-slate-900">{approval.title}</h3>
      {approval.detail ? (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-700">
          {approval.detail}
        </p>
      ) : null}

      {approval.kind === "question" ? (
        <div className="mt-4 space-y-3">
          {hasOptions ? (
            <div className="space-y-2">
              {(approval.options ?? []).map((option) => (
                <label
                  key={option}
                  className="flex cursor-pointer items-start gap-2 rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm text-slate-800 hover:border-amber-400"
                >
                  <input
                    type={approval.multiSelect ? "checkbox" : "radio"}
                    name={`approval-${approval.approvalId}`}
                    className="mt-0.5 accent-indigo-600"
                    checked={selected.includes(option)}
                    onChange={() => toggleOption(option)}
                    disabled={busy}
                  />
                  <span>{option}</span>
                </label>
              ))}
            </div>
          ) : null}
          <div>
            <label
              htmlFor={`approval-free-${approval.approvalId}`}
              className="mb-1 block text-xs font-medium text-slate-600"
            >
              {hasOptions ? "Something else (optional)" : "Your answer"}
            </label>
            <textarea
              id={`approval-free-${approval.approvalId}`}
              className={textareaClass}
              rows={2}
              value={freeText}
              onChange={(event) => setFreeText(event.target.value)}
              disabled={busy}
              placeholder="Type here, in your own words"
            />
          </div>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className={btn.primary}
              onClick={submitAnswer}
              disabled={busy || (selected.length === 0 && !freeText.trim())}
            >
              {busy ? "Sending…" : "Send answer"}
            </button>
            <button
              type="button"
              className={btn.subtle}
              onClick={() => void resolve("deny")}
              disabled={busy}
            >
              Skip this question
            </button>
          </div>
        </div>
      ) : (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <button
            type="button"
            className={btn.green}
            onClick={() => void resolve("approve")}
            disabled={busy}
          >
            {busy ? "Sending…" : "Allow"}
          </button>
          <button
            type="button"
            className={btn.subtle}
            onClick={() => void resolve("deny")}
            disabled={busy}
          >
            Don't allow
          </button>
        </div>
      )}

      <p className="mt-3 text-xs text-amber-700">
        If you don't answer, Sierge will say no for you.
      </p>
      <ErrorNote message={error} />
    </div>
  );
}
