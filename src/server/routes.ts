import type { FastifyInstance } from "fastify";
import {
  createProject,
  getProject,
  listContextDocs,
  listProjects,
  updateContextDoc,
  composeContextBundle,
} from "./stores/projects.js";
import {
  listTasks,
  loadTask,
  newTask,
  saveTask,
  transition,
} from "./stores/tasks.js";
import { createTaskWorktree } from "./gitManager.js";
import {
  acceptTask,
  approvePlan,
  discardTask,
  requestChanges,
  startPlanning,
} from "./orchestrator.js";
import { approvalBroker } from "./policy/engine.js";
import { taskEvents } from "./events.js";
import { getPreview, startPreview, stopPreview } from "./preview.js";
import { runPreflight } from "./preflight.js";
import type {
  ApproveplanBody,
  CreateProjectBody,
  CreateTaskBody,
  ProjectDetail,
  RequestChangesBody,
  ResolveApprovalBody,
} from "../shared/api.js";
import type { ProjectSummary, Task } from "../shared/types.js";

async function findTask(
  taskId: string,
): Promise<{ project: ProjectSummary; task: Task } | null> {
  for (const project of await listProjects()) {
    const task = await loadTask(project.id, taskId);
    if (task) return { project, task };
  }
  return null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export async function registerRoutes(app: FastifyInstance): Promise<void> {
  app.setErrorHandler((err, _req, reply) => {
    void reply.status(400).send({ error: errMessage(err) });
  });

  app.get("/api/preflight", async () => runPreflight());

  // --- projects -----------------------------------------------------------

  app.get("/api/projects", async () => listProjects());

  app.post<{ Body: CreateProjectBody }>("/api/projects", async (req) => {
    return createProject(req.body?.name ?? "", req.body?.repoPath);
  });

  app.get<{ Params: { id: string } }>("/api/projects/:id", async (req, reply) => {
    const project = await getProject(req.params.id);
    if (!project) return reply.status(404).send({ error: "Project not found." });
    const detail: ProjectDetail = {
      ...project,
      contextDocs: await listContextDocs(project),
      tasks: await listTasks(project.id),
    };
    return detail;
  });

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/context",
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.status(404).send({ error: "Project not found." });
      return listContextDocs(project);
    },
  );

  app.put<{ Params: { id: string; slug: string }; Body: { body: string } }>(
    "/api/projects/:id/context/:slug",
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.status(404).send({ error: "Project not found." });
      return updateContextDoc(project, req.params.slug, req.body?.body ?? "");
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/context-preview",
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.status(404).send({ error: "Project not found." });
      return { text: await composeContextBundle(project) };
    },
  );

  // --- tasks --------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/api/projects/:id/tasks",
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.status(404).send({ error: "Project not found." });
      return listTasks(project.id);
    },
  );

  app.post<{ Params: { id: string }; Body: CreateTaskBody }>(
    "/api/projects/:id/tasks",
    async (req, reply) => {
      const project = await getProject(req.params.id);
      if (!project) return reply.status(404).send({ error: "Project not found." });
      const request = (req.body?.request ?? "").trim();
      if (!request)
        return reply.status(400).send({ error: "Describe what you want changed." });

      const task = newTask(
        project.id,
        req.body?.title ?? "",
        request,
        "",
        "",
      );
      // Worktree is created BEFORE planning so plan + implementation share
      // one cwd (ADR-0002 session continuity).
      const wt = await createTaskWorktree(project.repoPath, project.id, task.id);
      task.branchName = wt.branchName;
      task.worktreePath = wt.worktreePath;
      await saveTask(task);
      await taskEvents.emit(
        { projectId: project.id, taskId: task.id },
        {
          type: "owner_action",
          taskId: task.id,
          action: "request_created",
          detail: request,
        },
      );
      return task;
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      return found.task;
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/plan",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      if (!["draft", "plan_ready"].includes(found.task.status)) {
        return reply
          .status(409)
          .send({ error: "Planning can start from a new or re-planned task." });
      }
      // Long-running: kicked off in the background, progress over SSE.
      void startPlanning(found.project, found.task);
      return { ok: true };
    },
  );

  app.post<{ Params: { taskId: string }; Body: ApproveplanBody }>(
    "/api/tasks/:taskId/plan/approve",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      const markdown = (req.body?.markdown ?? "").trim();
      if (!markdown)
        return reply.status(400).send({ error: "The plan cannot be empty." });
      await approvePlan(found.project, found.task, markdown);
      return { ok: true };
    },
  );

  app.post<{ Params: { taskId: string; approvalId: string }; Body: ResolveApprovalBody }>(
    "/api/tasks/:taskId/approvals/:approvalId",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      const { decision, answer } = req.body ?? {};
      const pending = approvalBroker
        .listForTask(req.params.taskId)
        .find((a) => a.approvalId === req.params.approvalId);
      if (!pending)
        return reply
          .status(404)
          .send({ error: "This approval has already been resolved or expired." });

      const resolution =
        pending.kind === "question"
          ? decision === "approve"
            ? "answered"
            : "denied"
          : decision === "approve"
            ? "approved"
            : "denied";
      const ok = await approvalBroker.resolve(
        { projectId: found.project.id, taskId: found.task.id },
        req.params.approvalId,
        resolution,
        answer ?? null,
      );
      return { ok };
    },
  );

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/approvals",
    async (req) => approvalBroker.listForTask(req.params.taskId),
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/accept",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      await acceptTask(found.project, found.task);
      return { ok: true };
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/discard",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      await discardTask(found.project, found.task);
      return { ok: true };
    },
  );

  app.post<{ Params: { taskId: string }; Body: RequestChangesBody }>(
    "/api/tasks/:taskId/request-changes",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      const feedback = (req.body?.feedback ?? "").trim();
      if (!feedback)
        return reply.status(400).send({ error: "Describe what should change." });
      await requestChanges(found.project, found.task, feedback);
      return { ok: true };
    },
  );

  // --- preview ------------------------------------------------------------

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/preview",
    async (req) => getPreview(req.params.taskId),
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/preview/start",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) return reply.status(404).send({ error: "Task not found." });
      return startPreview(found.task.id, found.task.worktreePath);
    },
  );

  app.post<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/preview/stop",
    async (req) => stopPreview(req.params.taskId),
  );

  // --- SSE event stream ---------------------------------------------------

  app.get<{ Params: { taskId: string } }>(
    "/api/tasks/:taskId/events",
    async (req, reply) => {
      const found = await findTask(req.params.taskId);
      if (!found) {
        return reply.status(404).send({ error: "Task not found." });
      }
      const { project, task } = found;
      const ref = { projectId: project.id, taskId: task.id };

      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });

      const send = (data: unknown) => {
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      // 1. Current snapshot, 2. full replay, 3. live.
      send({ type: "task_snapshot", task });
      for (const event of await taskEvents.replay(ref)) send(event);
      for (const approval of approvalBroker.listForTask(task.id)) {
        send({
          type: "approval_request",
          id: approval.approvalId,
          ts: approval.createdAt,
          taskId: task.id,
          approvalId: approval.approvalId,
          kind: approval.kind,
          title: approval.title,
          detail: approval.detail,
          options: approval.options,
          multiSelect: approval.multiSelect,
        });
      }

      const unsubscribe = taskEvents.subscribe(task.id, send);
      const heartbeat = setInterval(() => {
        reply.raw.write(": keep-alive\n\n");
      }, 25_000);

      req.raw.on("close", () => {
        clearInterval(heartbeat);
        unsubscribe();
      });

      // Keep the connection open; Fastify must not try to send a response.
      return reply;
    },
  );
}
