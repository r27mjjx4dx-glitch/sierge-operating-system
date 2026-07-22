import path from "node:path";
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import { readJson, writeJsonAtomic } from "../fsStore.js";
import { taskDataDir, tasksDataRoot } from "../config.js";
import { taskEvents } from "../events.js";
import type { Task, TaskStatus } from "../../shared/types.js";

/**
 * Task persistence + the status state machine. Every transition is written
 * to disk BEFORE the caller proceeds (ADR-0002 crash-safety discipline), and
 * every transition is a first-class audit event. Illegal transitions throw.
 */

const TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  draft: ["planning", "discarded"],
  planning: ["plan_ready", "failed", "discarded"],
  plan_ready: ["planning", "implementing", "discarded"],
  implementing: ["validating", "failed", "discarded"],
  validating: ["review", "implementing", "failed", "discarded"],
  review: ["accepted", "discarded", "implementing"],
  accepted: [],
  discarded: [],
  failed: ["discarded", "implementing"],
};

function taskFile(projectId: string, taskId: string): string {
  return path.join(taskDataDir(projectId, taskId), "task.json");
}

export async function loadTask(
  projectId: string,
  taskId: string,
): Promise<Task | null> {
  return readJson<Task | null>(taskFile(projectId, taskId), null);
}

export async function saveTask(task: Task): Promise<void> {
  task.updatedAt = new Date().toISOString();
  await writeJsonAtomic(taskFile(task.projectId, task.id), task);
}

export async function listTasks(projectId: string): Promise<Task[]> {
  const dir = path.join(tasksDataRoot, projectId, "tasks");
  let ids: string[] = [];
  try {
    ids = await fsp.readdir(dir);
  } catch {
    return [];
  }
  const tasks: Task[] = [];
  for (const id of ids) {
    const t = await loadTask(projectId, id);
    if (t) tasks.push(t);
  }
  return tasks.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function newTask(
  projectId: string,
  title: string,
  ownerRequest: string,
  branchName: string,
  worktreePath: string,
): Task {
  const now = new Date().toISOString();
  return {
    id: crypto.randomUUID().slice(0, 8),
    projectId,
    title: title.trim() || ownerRequest.slice(0, 60),
    ownerRequest,
    status: "draft",
    branchName,
    worktreePath,
    planSessionId: null,
    implSessionId: null,
    plan: null,
    planHistory: [],
    validation: null,
    review: null,
    costUsdEstimate: 0,
    failureReason: null,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Transition the task. Persists BEFORE returning; emits the audit event and
 * a fresh snapshot for connected UIs. Throws on an illegal transition.
 */
export async function transition(
  task: Task,
  to: TaskStatus,
  reason: string | null = null,
): Promise<Task> {
  const allowed = TRANSITIONS[task.status] ?? [];
  if (!allowed.includes(to)) {
    throw new Error(
      `Illegal task transition ${task.status} -> ${to} (task ${task.id})`,
    );
  }
  const from = task.status;
  task.status = to;
  if (to === "failed") task.failureReason = reason;
  await saveTask(task);
  const ref = { projectId: task.projectId, taskId: task.id };
  await taskEvents.emit(ref, {
    type: "state_change",
    taskId: task.id,
    from,
    to,
    reason,
  });
  taskEvents.broadcast(ref, { type: "task_snapshot", task });
  return task;
}

export function broadcastSnapshot(task: Task): void {
  taskEvents.broadcast(
    { projectId: task.projectId, taskId: task.id },
    { type: "task_snapshot", task },
  );
}

/**
 * Crash recovery: any task found mid-flight at boot is marked failed with an
 * honest reason — in-progress work is never presented as done, and the owner
 * can restart implementation from the approved plan.
 */
export async function recoverInterruptedTasks(
  projectIds: string[],
): Promise<number> {
  let recovered = 0;
  for (const projectId of projectIds) {
    for (const task of await listTasks(projectId)) {
      if (["planning", "implementing", "validating"].includes(task.status)) {
        await transition(
          task,
          "failed",
          "Sierge was restarted while this task was running. The work so far is preserved on the task branch; you can retry from the approved plan.",
        );
        recovered += 1;
      }
    }
  }
  return recovered;
}
