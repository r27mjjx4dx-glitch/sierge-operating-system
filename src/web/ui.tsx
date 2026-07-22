// Small shared UI primitives: status badges, button styles, cards, spinners,
// relative time, and a tiny hand-rolled markdown renderer.

import { useMemo } from "react";
import type { ReactNode } from "react";
import type { TaskStatus } from "../shared/types";

// --- Button / input class strings -----------------------------------------

export const btn = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-indigo-700 disabled:cursor-not-allowed disabled:opacity-50",
  green:
    "inline-flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-green-700 disabled:cursor-not-allowed disabled:opacity-50",
  subtle:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50",
  dangerOutline:
    "inline-flex items-center justify-center gap-2 rounded-lg border border-red-300 bg-white px-4 py-2 text-sm font-medium text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50",
} as const;

export const inputClass =
  "w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 placeholder:text-slate-400 focus:border-indigo-400 focus:outline-none focus:ring-2 focus:ring-indigo-100";

export const textareaClass = inputClass + " leading-relaxed";

// --- Layout bits -----------------------------------------------------------

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-slate-200 bg-white p-5 shadow-sm ${className}`}>
      {children}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return <p className="mt-2 text-sm text-red-600">{message}</p>;
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="inline-flex items-center gap-2 text-sm text-slate-500">
      <span
        aria-hidden="true"
        className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-indigo-200 border-t-indigo-600"
      />
      {label ? <span>{label}</span> : null}
    </span>
  );
}

// --- Status badge ----------------------------------------------------------

const STATUS_META: Record<TaskStatus, { label: string; className: string; pulse?: boolean }> = {
  draft: { label: "Draft", className: "bg-slate-100 text-slate-600" },
  planning: { label: "Writing a plan", className: "bg-blue-100 text-blue-700", pulse: true },
  plan_ready: { label: "Waiting for your approval", className: "bg-amber-100 text-amber-800" },
  implementing: { label: "Building", className: "bg-blue-100 text-blue-700", pulse: true },
  validating: { label: "Running checks", className: "bg-blue-100 text-blue-700", pulse: true },
  review: { label: "Ready for your review", className: "bg-purple-100 text-purple-700" },
  accepted: { label: "Accepted", className: "bg-green-100 text-green-700" },
  discarded: { label: "Discarded", className: "bg-slate-100 text-slate-500" },
  failed: { label: "Hit a problem", className: "bg-red-100 text-red-700" },
};

export function StatusBadge({ status }: { status: TaskStatus }) {
  const meta = STATUS_META[status];
  return (
    <span
      className={`inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-medium ${meta.className}`}
    >
      {meta.pulse ? (
        <span aria-hidden="true" className="inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-current" />
      ) : null}
      {meta.label}
    </span>
  );
}

// --- Time helpers ----------------------------------------------------------

export function relativeTime(ts: string): string {
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return "";
  const diff = Date.now() - then;
  if (diff < 15_000) return "just now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  const days = Math.floor(diff / 86_400_000);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;
  return new Date(ts).toLocaleDateString();
}

export function formatDate(ts: string): string {
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function formatDuration(ms: number | null): string {
  if (ms === null) return "";
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

// --- Tiny markdown renderer (hand-rolled, no library) ----------------------

type MdBlock =
  | { kind: "heading"; level: number; text: string; key: number }
  | { kind: "bullets"; items: string[]; key: number }
  | { kind: "numbered"; items: string[]; key: number }
  | { kind: "para"; text: string; key: number };

function parseMarkdownBlocks(text: string): MdBlock[] {
  const blocks: MdBlock[] = [];
  let para: string[] = [];
  let key = 0;
  const flushPara = () => {
    if (para.length > 0) {
      blocks.push({ kind: "para", text: para.join("\n"), key: key++ });
      para = [];
    }
  };
  for (const line of text.split("\n")) {
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (heading) {
      flushPara();
      blocks.push({ kind: "heading", level: heading[1]?.length ?? 2, text: heading[2] ?? "", key: key++ });
    } else if (bullet) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "bullets") last.items.push(bullet[1] ?? "");
      else blocks.push({ kind: "bullets", items: [bullet[1] ?? ""], key: key++ });
    } else if (numbered) {
      flushPara();
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "numbered") last.items.push(numbered[1] ?? "");
      else blocks.push({ kind: "numbered", items: [numbered[1] ?? ""], key: key++ });
    } else if (line.trim() === "") {
      flushPara();
    } else {
      para.push(line);
    }
  }
  flushPara();
  return blocks;
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-lg font-semibold text-slate-900",
  2: "text-base font-semibold text-slate-900",
  3: "text-sm font-semibold text-slate-900",
  4: "text-sm font-semibold text-slate-700",
};

export function MarkdownLite({ text }: { text: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(text), [text]);
  return (
    <div className="space-y-3 text-sm leading-relaxed text-slate-700">
      {blocks.map((block) => {
        if (block.kind === "heading") {
          return (
            <p key={block.key} className={HEADING_CLASS[block.level] ?? HEADING_CLASS[2]}>
              {block.text}
            </p>
          );
        }
        if (block.kind === "bullets") {
          return (
            <ul key={block.key} className="list-disc space-y-1 pl-5">
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          );
        }
        if (block.kind === "numbered") {
          return (
            <ol key={block.key} className="list-decimal space-y-1 pl-5">
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ol>
          );
        }
        return (
          <p key={block.key} className="whitespace-pre-wrap">
            {block.text}
          </p>
        );
      })}
    </div>
  );
}
