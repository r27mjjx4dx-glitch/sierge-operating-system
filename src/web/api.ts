// Typed fetch helpers for every REST route in src/shared/api.ts, plus the SSE
// subscription for task events.

import type {
  ContextDoc,
  PendingApproval,
  PreflightReport,
  PreviewState,
  ProjectSummary,
  Task,
  WireEvent,
} from "../shared/types";
import type {
  CreateProjectBody,
  CreateTaskBody,
  ProjectDetail,
  ResolveApprovalBody,
} from "../shared/api";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, init);
  } catch {
    throw new Error("Couldn't reach Sierge. Is it still running on this computer?");
  }
  if (!res.ok) {
    let message = `Something went wrong (code ${res.status}).`;
    try {
      const body: unknown = await res.json();
      if (
        body !== null &&
        typeof body === "object" &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      // keep the default message
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

function jsonInit(method: string, body?: unknown): RequestInit {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  };
}

const enc = encodeURIComponent;

// --- Preflight -------------------------------------------------------------

export function getPreflight(): Promise<PreflightReport> {
  return request<PreflightReport>("/api/preflight");
}

// --- Projects --------------------------------------------------------------

export function listProjects(): Promise<ProjectSummary[]> {
  return request<ProjectSummary[]>("/api/projects");
}

export function createProject(body: CreateProjectBody): Promise<ProjectSummary> {
  return request<ProjectSummary>("/api/projects", jsonInit("POST", body));
}

export function getProject(id: string): Promise<ProjectDetail> {
  return request<ProjectDetail>(`/api/projects/${enc(id)}`);
}

export function getContextDocs(id: string): Promise<ContextDoc[]> {
  return request<ContextDoc[]>(`/api/projects/${enc(id)}/context`);
}

export function saveContextDoc(id: string, slug: string, body: string): Promise<ContextDoc> {
  return request<ContextDoc>(
    `/api/projects/${enc(id)}/context/${enc(slug)}`,
    jsonInit("PUT", { body }),
  );
}

export function getContextPreview(id: string): Promise<{ text: string }> {
  return request<{ text: string }>(`/api/projects/${enc(id)}/context-preview`);
}

// --- Tasks -----------------------------------------------------------------

export function listTasks(projectId: string): Promise<Task[]> {
  return request<Task[]>(`/api/projects/${enc(projectId)}/tasks`);
}

export function createTask(projectId: string, body: CreateTaskBody): Promise<Task> {
  return request<Task>(`/api/projects/${enc(projectId)}/tasks`, jsonInit("POST", body));
}

export function getTask(taskId: string): Promise<Task> {
  return request<Task>(`/api/tasks/${enc(taskId)}`);
}

export function startPlan(taskId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/tasks/${enc(taskId)}/plan`, jsonInit("POST"));
}

export function approvePlan(taskId: string, markdown: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/tasks/${enc(taskId)}/plan/approve`,
    jsonInit("POST", { markdown }),
  );
}

export function resolveApproval(
  taskId: string,
  approvalId: string,
  body: ResolveApprovalBody,
): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/tasks/${enc(taskId)}/approvals/${enc(approvalId)}`,
    jsonInit("POST", body),
  );
}

export function acceptTask(taskId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/tasks/${enc(taskId)}/accept`, jsonInit("POST"));
}

export function discardTask(taskId: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(`/api/tasks/${enc(taskId)}/discard`, jsonInit("POST"));
}

export function requestChanges(taskId: string, feedback: string): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>(
    `/api/tasks/${enc(taskId)}/request-changes`,
    jsonInit("POST", { feedback }),
  );
}

export function listPendingApprovals(taskId: string): Promise<PendingApproval[]> {
  return request<PendingApproval[]>(`/api/tasks/${enc(taskId)}/approvals`);
}

// --- Preview ---------------------------------------------------------------

export function getPreview(taskId: string): Promise<PreviewState> {
  return request<PreviewState>(`/api/tasks/${enc(taskId)}/preview`);
}

export function startPreview(taskId: string): Promise<PreviewState> {
  return request<PreviewState>(`/api/tasks/${enc(taskId)}/preview/start`, jsonInit("POST"));
}

export function stopPreview(taskId: string): Promise<PreviewState> {
  return request<PreviewState>(`/api/tasks/${enc(taskId)}/preview/stop`, jsonInit("POST"));
}

// --- SSE -------------------------------------------------------------------

/**
 * Subscribe to a task's event stream. Each SSE message's data is one JSON
 * WireEvent. EventSource reconnects on its own; on reconnect the server
 * replays everything, so callers should dedupe TaskEvents by `id` and treat
 * `task_snapshot` as a full replacement of the task object.
 */
export function subscribeTaskEvents(
  taskId: string,
  onEvent: (e: WireEvent) => void,
): () => void {
  const source = new EventSource(`/api/tasks/${enc(taskId)}/events`);
  source.onmessage = (message: MessageEvent) => {
    try {
      onEvent(JSON.parse(String(message.data)) as WireEvent);
    } catch {
      // ignore malformed frames
    }
  };
  return () => source.close();
}
