import { beforeAll, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execa } from "execa";

// Point Sierge's data root at a temp dir BEFORE importing config-dependent
// modules (config.ts reads env at import time).
let git: typeof import("../src/server/gitManager.js");

beforeAll(async () => {
  process.env.SIERGE_DATA_DIR = await fsp.mkdtemp(
    path.join(os.tmpdir(), "sierge-git-data-"),
  );
  git = await import("../src/server/gitManager.js");
});

async function freshRepo(): Promise<string> {
  const repo = await fsp.mkdtemp(path.join(os.tmpdir(), "sierge-repo-"));
  await git.ensureRepo(repo);
  return repo;
}

describe("git worktree + merge lifecycle", () => {
  it("creates a task worktree on its own branch", async () => {
    const repo = await freshRepo();
    const { branchName, worktreePath } = await git.createTaskWorktree(
      repo,
      "proj1",
      "taskA",
    );
    expect(branchName).toBe("sierge/task-taskA");
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(await git.branchExists(repo, branchName)).toBe(true);
    expect(await git.isMergedIntoMain(repo, branchName)).toBe(true); // no commits yet
  });

  it("merges an accepted task and is IDEMPOTENT on a repeat call", async () => {
    const repo = await freshRepo();
    const { branchName, worktreePath } = await git.createTaskWorktree(
      repo,
      "proj2",
      "taskB",
    );
    await fsp.writeFile(path.join(worktreePath, "feature.txt"), "hello\n");
    await execa("git", ["add", "-A"], { cwd: worktreePath });
    await execa("git", ["commit", "-m", "add feature"], { cwd: worktreePath });

    expect(await git.isMergedIntoMain(repo, branchName)).toBe(false);
    const sha1 = await git.mergeTask(repo, branchName, "Accept taskB");
    expect(await git.isMergedIntoMain(repo, branchName)).toBe(true);

    // A second merge (e.g. a crash-recovery retry) must not throw.
    const sha2 = await git.mergeTask(repo, branchName, "Accept taskB again");
    expect(sha2).toBe(sha1);

    // main now contains the file.
    expect(fs.existsSync(path.join(repo, "feature.txt"))).toBe(true);
  });

  it("mergeTask is idempotent even after the branch is deleted", async () => {
    const repo = await freshRepo();
    const { branchName, worktreePath } = await git.createTaskWorktree(
      repo,
      "proj3",
      "taskC",
    );
    await fsp.writeFile(path.join(worktreePath, "x.txt"), "x\n");
    await execa("git", ["add", "-A"], { cwd: worktreePath });
    await execa("git", ["commit", "-m", "x"], { cwd: worktreePath });
    await git.mergeTask(repo, branchName, "Accept taskC");
    await git.removeTaskWorktree(repo, "proj3", "taskC", "delete-merged");

    expect(await git.branchExists(repo, branchName)).toBe(false);
    // No branch to merge — returns main HEAD rather than throwing.
    await expect(
      git.mergeTask(repo, branchName, "retry"),
    ).resolves.toBeTruthy();
  });

  it("removeTaskWorktree is idempotent (safe to call twice)", async () => {
    const repo = await freshRepo();
    await git.createTaskWorktree(repo, "proj4", "taskD");
    await git.removeTaskWorktree(repo, "proj4", "taskD", "force-delete");
    await expect(
      git.removeTaskWorktree(repo, "proj4", "taskD", "force-delete"),
    ).resolves.toBeUndefined();
  });

  it("refuses to merge over a dirty main checkout", async () => {
    const repo = await freshRepo();
    const { branchName, worktreePath } = await git.createTaskWorktree(
      repo,
      "proj5",
      "taskE",
    );
    await fsp.writeFile(path.join(worktreePath, "f.txt"), "f\n");
    await execa("git", ["add", "-A"], { cwd: worktreePath });
    await execa("git", ["commit", "-m", "f"], { cwd: worktreePath });
    // Dirty the main checkout.
    await fsp.writeFile(path.join(repo, "dirty.txt"), "uncommitted\n");
    await expect(
      git.mergeTask(repo, branchName, "Accept taskE"),
    ).rejects.toThrow(/uncommitted/i);
  });
});
