// REST + SSE contract between the Sierge server and the web UI.
// Base URL: same origin, prefix /api. All bodies are JSON.
//
// GET  /api/preflight                       -> PreflightReport
// GET  /api/projects                        -> ProjectSummary[]
// POST /api/projects {name, repoPath?}      -> ProjectSummary
// GET  /api/projects/:id                    -> ProjectDetail
// GET  /api/projects/:id/context            -> ContextDoc[]
// PUT  /api/projects/:id/context/:slug {body} -> ContextDoc
// GET  /api/projects/:id/context-preview    -> { text } (exact text sent to Claude)
// GET  /api/projects/:id/tasks              -> Task[]
// POST /api/projects/:id/tasks {title, request} -> Task   (creates worktree, status=draft)
// GET  /api/tasks/:id                       -> Task
// POST /api/tasks/:id/plan                  -> {ok} (draft -> planning; streams via SSE)
// POST /api/tasks/:id/plan/approve {markdown} -> {ok} (plan_ready -> implementing)
// POST /api/tasks/:id/approvals/:approvalId {decision: "approve"|"deny", answer?} -> {ok}
// POST /api/tasks/:id/accept                -> {ok} (review -> accepted; merge --no-ff)
// POST /api/tasks/:id/discard               -> {ok} (any non-terminal -> discarded)
// POST /api/tasks/:id/request-changes {feedback} -> {ok} (review -> implementing)
// GET  /api/tasks/:id/approvals             -> PendingApproval[]
// GET  /api/tasks/:id/events  (SSE)         -> replay of all TaskEvents, then live;
//                                              first frame is TaskSnapshotWireEvent,
//                                              snapshots re-sent on each state change
// POST /api/tasks/:id/preview/start         -> PreviewState
// POST /api/tasks/:id/preview/stop          -> PreviewState
// GET  /api/tasks/:id/preview               -> PreviewState

import type { ContextDoc, ProjectSummary, Task } from "./types.js";

export interface ProjectDetail extends ProjectSummary {
  contextDocs: ContextDoc[];
  tasks: Task[];
}

export interface CreateProjectBody {
  name: string;
  /** Optional absolute path. Default: <home>/SiergeProjects/<slug> */
  repoPath?: string;
}

export interface CreateTaskBody {
  title: string;
  request: string;
}

export interface ApproveplanBody {
  markdown: string;
}

export interface ResolveApprovalBody {
  decision: "approve" | "deny";
  /** For question cards: the selected answer(s), joined with "; ". */
  answer?: string;
}

export interface RequestChangesBody {
  feedback: string;
}

export interface ApiError {
  error: string;
}
