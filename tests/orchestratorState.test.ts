import { beforeAll, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";
import type { ProjectSummary, Task } from "../src/shared/types.js";

// Set the data root before importing any config-dependent module.
let tasksStore: typeof import("../src/server/stores/tasks.js");
let git: typeof import("../src/server/gitManager.js");
let orch: typeof import("../src/server/orchestrator.js");

beforeAll(async () => {
  process.env.SIERGE_DATA_DIR = await fsp.mkdtemp(
    path.join(os.tmpdir(), "sierge-orch-data-"),
  );
  tasksStore = await import("../src/server/stores/tasks.js");
  git = await import("../src/server/gitManager.js");
  orch = await import("../src/server/orchestrator.js");
});

async function makeProject(id: string): Promise<ProjectSummary> {
  const repoPath = await fsp.mkdtemp(path.join(os.tmpdir(), `sierge-${id}-`));
  await git.ensureRepo(repoPath);
  return { id, name: id, repoPath, createdAt: new Date().toISOString() };
}

async function seedTask(
  project: ProjectSummary,
  taskId: string,
  overrides: Partial<Task>,
): Promise<Task> {
  const wt = await git.createTaskWorktree(project.repoPath, project.id, taskId);
  const task = tasksStore.newTask(
    project.id,
    "Test task",
    "do a thing",
    wt.branchName,
    wt.worktreePath,
  );
  Object.assign(task, { id: taskId, ...overrides });
  await tasksStore.saveTask(task);
  return task;
}

async function commitOnBranch(worktreePath: string, name: string) {
  await fsp.writeFile(path.join(worktreePath, name), "content\n");
  await execa("git", ["add", "-A"], { cwd: worktreePath });
  await execa("git", ["commit", "-m", `add ${name}`], { cwd: worktreePath });
}

describe("state machine transitions", () => {
  it("allows failed -> planning (rewrite a plan after a planning failure)", async () => {
    const project = await makeProject("smproj");
    const task = await seedTask(project, "t-replan", { status: "failed" });
    await expect(tasksStore.transition(task, "planning", null)).resolves.toBeTruthy();
    expect(task.status).toBe("planning");
  });

  it("allows review -> accepted and failed -> implementing", async () => {
    const project = await makeProject("smproj2");
    const t1 = await seedTask(project, "t-acc", { status: "review" });
    await expect(tasksStore.transition(t1, "accepted", null)).resolves.toBeTruthy();
    const t2 = await seedTask(project, "t-impl", { status: "failed" });
    await expect(tasksStore.transition(t2, "implementing", null)).resolves.toBeTruthy();
  });

  it("rejects an illegal transition (accepted is terminal)", async () => {
    const project = await makeProject("smproj3");
    const task = await seedTask(project, "t-term", { status: "accepted" });
    await expect(tasksStore.transition(task, "implementing", null)).rejects.toThrow(
      /Illegal task transition/,
    );
  });
});

describe("crash recovery", () => {
  it("marks mid-flight tasks failed on restart", async () => {
    const project = await makeProject("recproj");
    await seedTask(project, "r-impl", { status: "implementing" });
    await seedTask(project, "r-val", { status: "validating" });
    await seedTask(project, "r-plan", { status: "planning" });
    await seedTask(project, "r-done", { status: "accepted" });

    const n = await tasksStore.recoverInterruptedTasks([project.id]);
    expect(n).toBe(3);
    expect((await tasksStore.loadTask(project.id, "r-impl"))?.status).toBe("failed");
    expect((await tasksStore.loadTask(project.id, "r-val"))?.status).toBe("failed");
    expect((await tasksStore.loadTask(project.id, "r-plan"))?.status).toBe("failed");
    expect((await tasksStore.loadTask(project.id, "r-done"))?.status).toBe("accepted");
  });
});

describe("interrupted-accept reconciliation", () => {
  it("completes an accept whose merge already landed", async () => {
    const project = await makeProject("accmerged");
    const task = await seedTask(project, "a-merged", {
      status: "review",
      acceptInProgress: true,
    });
    await commitOnBranch(task.worktreePath, "feature.txt");
    const sha = await git.mergeTask(project.repoPath, task.branchName, "merge");
    task.acceptMergeSha = sha;
    await tasksStore.saveTask(task);

    const n = await orch.reconcileInterruptedAccepts([project]);
    expect(n).toBe(1);
    const reloaded = await tasksStore.loadTask(project.id, "a-merged");
    expect(reloaded?.status).toBe("accepted");
    expect(reloaded?.acceptInProgress).toBe(false);
  });

  it("leaves an accept whose merge never happened safely in review", async () => {
    const project = await makeProject("accunmerged");
    const task = await seedTask(project, "a-unmerged", {
      status: "review",
      acceptInProgress: true,
    });
    await commitOnBranch(task.worktreePath, "feature.txt"); // committed but NOT merged

    const n = await orch.reconcileInterruptedAccepts([project]);
    expect(n).toBe(1);
    const reloaded = await tasksStore.loadTask(project.id, "a-unmerged");
    expect(reloaded?.status).toBe("review");
    expect(reloaded?.acceptInProgress).toBe(false);
    // main must NOT contain the unmerged file.
    const { execa: x } = await import("execa");
    const files = await x("git", ["ls-files"], { cwd: project.repoPath });
    expect(String(files.stdout)).not.toContain("feature.txt");
  });
});

describe("approval gate on failed -> implementing (bypass fix)", () => {
  it("rejects request-changes on a failed task with no approved plan", async () => {
    const project = await makeProject("gateproj");
    const task = await seedTask(project, "g-noplan", {
      status: "failed",
      planApproved: false,
    });
    await expect(orch.requestChanges(project, task, "keep going")).rejects.toThrow(
      /approved a plan|approve a plan/i,
    );
    // Status unchanged — it did NOT enter implementation.
    expect((await tasksStore.loadTask(project.id, "g-noplan"))?.status).toBe("failed");
  });

  it("rejects request-changes from a draft task", async () => {
    const project = await makeProject("gateproj2");
    const task = await seedTask(project, "g-draft", { status: "draft" });
    await expect(orch.requestChanges(project, task, "x")).rejects.toThrow();
  });
});

describe("acceptTask concurrency guard", () => {
  it("serializes concurrent accepts: exactly one succeeds", async () => {
    const project = await makeProject("concacc");
    const task = await seedTask(project, "c-acc", { status: "review" });
    await commitOnBranch(task.worktreePath, "feature.txt");

    // Two fresh in-memory copies, mirroring two concurrent HTTP requests.
    const t1 = (await tasksStore.loadTask(project.id, "c-acc"))!;
    const t2 = (await tasksStore.loadTask(project.id, "c-acc"))!;
    const results = await Promise.allSettled([
      orch.acceptTask(project, t1),
      orch.acceptTask(project, t2),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled").length;
    const rejected = results.filter((r) => r.status === "rejected").length;
    expect(fulfilled).toBe(1);
    expect(rejected).toBe(1);
    expect((await tasksStore.loadTask(project.id, "c-acc"))?.status).toBe("accepted");
  });

  it("rejects accepting a task that is not in review", async () => {
    const project = await makeProject("accnonreview");
    const task = await seedTask(project, "n-rev", { status: "implementing" });
    await expect(orch.acceptTask(project, task)).rejects.toThrow(/review/i);
  });
});
