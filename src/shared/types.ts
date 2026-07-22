// Shared domain types for Sierge. Both the server and the web UI import from
// this file; it is the single contract between them.

export type TaskStatus =
  | "draft"
  | "planning"
  | "plan_ready"
  | "implementing"
  | "validating"
  | "review"
  | "accepted"
  | "discarded"
  | "failed";

export interface ProjectSummary {
  id: string;
  name: string;
  repoPath: string;
  createdAt: string;
}

export interface ContextDoc {
  slug: string; // e.g. "overview", "decisions"
  title: string;
  body: string;
  updatedAt: string;
}

export interface PlanSections {
  outcome?: string;
  assumptions?: string[];
  affectedAreas?: string[];
  acceptanceCriteria?: string[];
  steps?: string[];
}

export interface Plan {
  version: number;
  markdown: string; // raw markdown is always the source of truth
  sections: PlanSections; // best-effort parse; may be partial
  editedByOwner: boolean;
  createdAt: string;
}

// A task carries `planApproved` once the owner has explicitly approved a plan.
// It gates the failed -> implementing retry path so a task that failed during
// planning (no approved plan) can never be driven into implementation.

export type ValidationStatus = "passed" | "failed" | "unavailable" | "skipped";

export interface ValidationCheck {
  name: string; // test | lint | typecheck | build
  command: string | null;
  status: ValidationStatus;
  exitCode: number | null;
  durationMs: number | null;
  logTail: string | null; // last lines of output for the UI
}

export interface ValidationReport {
  checks: ValidationCheck[];
  overall: "passed" | "failed" | "partial" | "none";
  ranAt: string;
  fixRound: number; // 0 = first run, 1..2 = after auto-fix rounds
}

export interface FileChange {
  path: string;
  changeType: "added" | "modified" | "deleted" | "renamed";
  plainDescription: string | null;
}

export interface ReviewPacket {
  summaryMarkdown: string | null; // Claude's handoff summary
  changedFiles: FileChange[];
  diffStat: string | null;
  validation: ValidationReport | null;
  caveats: string[]; // machine-derived: denied calls, unevidenced criteria, unavailable checks
  costUsdEstimate: number;
}

export interface PreviewState {
  status: "stopped" | "starting" | "ready" | "failed" | "unavailable";
  url: string | null;
  detail: string | null;
}

export interface Task {
  id: string;
  projectId: string;
  title: string;
  ownerRequest: string;
  status: TaskStatus;
  branchName: string;
  worktreePath: string;
  planSessionId: string | null;
  implSessionId: string | null;
  plan: Plan | null;
  planHistory: Plan[];
  planApproved: boolean;
  validation: ValidationReport | null;
  review: ReviewPacket | null;
  costUsdEstimate: number;
  failureReason: string | null;
  // Accept crash-atomicity: set before the merge starts, and the resulting
  // commit recorded after it succeeds, so a crash mid-accept is reconciled on
  // restart (an already-merged task is completed, not left stuck in "review").
  acceptInProgress: boolean;
  acceptMergeSha: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Audit / activity events. Appended (JSONL) to the task's events file; the
// UI replays them on load and receives new ones over SSE.
// ---------------------------------------------------------------------------

export type PolicyDecision =
  | "allow"
  | "deny"
  | "ask_allow"
  | "ask_deny"
  | "ask_timeout_deny";

export type DecidedBy = "hard_deny" | "policy" | "owner" | "timeout";

export interface BaseEvent {
  id: string;
  ts: string;
  taskId: string;
}

export interface StateChangeEvent extends BaseEvent {
  type: "state_change";
  from: TaskStatus | null;
  to: TaskStatus;
  reason: string | null;
}

export interface AssistantTextEvent extends BaseEvent {
  type: "assistant_text";
  phase: "plan" | "implement" | "summarize";
  delta: string;
}

export interface ToolAttemptEvent extends BaseEvent {
  type: "tool_attempt";
  phase: "plan" | "implement" | "summarize";
  tool: string;
  inputSummary: string; // truncated/safe rendering of the input
  plainSummary: string; // narration-layer text for the owner
}

export interface PolicyDecisionEvent extends BaseEvent {
  type: "policy_decision";
  tool: string;
  decision: PolicyDecision;
  decidedBy: DecidedBy;
  reason: string;
  plainSummary: string;
}

export interface ApprovalRequestEvent extends BaseEvent {
  type: "approval_request";
  approvalId: string;
  kind: "tool" | "question";
  title: string;
  detail: string;
  options: string[] | null; // for question cards
  multiSelect?: boolean;
}

export interface ApprovalResolvedEvent extends BaseEvent {
  type: "approval_resolved";
  approvalId: string;
  resolution: "approved" | "denied" | "answered" | "timeout";
  answer: string | null;
}

export interface OwnerActionEvent extends BaseEvent {
  type: "owner_action";
  action:
    | "request_created"
    | "plan_approved"
    | "plan_edited"
    | "accepted"
    | "discarded"
    | "changes_requested";
  detail: string | null;
}

export interface ValidationEvent extends BaseEvent {
  type: "validation";
  report: ValidationReport;
}

export interface SystemNoteEvent extends BaseEvent {
  type: "system_note";
  level: "info" | "warn" | "error";
  text: string;
}

export type TaskEvent =
  | StateChangeEvent
  | AssistantTextEvent
  | ToolAttemptEvent
  | PolicyDecisionEvent
  | ApprovalRequestEvent
  | ApprovalResolvedEvent
  | OwnerActionEvent
  | ValidationEvent
  | SystemNoteEvent;

// SSE wire format: each SSE `data:` line is one JSON-encoded TaskEvent, plus a
// synthetic snapshot event so late joiners get current task state.
export interface TaskSnapshotWireEvent {
  type: "task_snapshot";
  task: Task;
}

export type WireEvent = TaskEvent | TaskSnapshotWireEvent;

// ---------------------------------------------------------------------------
// Pending approvals (blocking cards)
// ---------------------------------------------------------------------------

export interface PendingApproval {
  approvalId: string;
  taskId: string;
  kind: "tool" | "question";
  title: string;
  detail: string;
  options: string[] | null;
  multiSelect?: boolean;
  createdAt: string;
  expiresAt: string;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  selfTest: { status: "passed" | "failed" | "not_run"; detail: string };
}
