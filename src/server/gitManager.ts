import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import { execa, type Options as ExecaOptions } from "execa";
import { worktreesRoot } from "./config.js";
import type { FileChange } from "../shared/types.js";

/**
 * All git operations in Sierge go through this module, and the merge into the
 * owner's accepted state (main) exists ONLY here — the agent is never granted
 * merge/push/tag capability (those commands are hard-denied by policy).
 */

async function git(
  cwd: string,
  args: string[],
  opts: ExecaOptions = {},
): Promise<string> {
  const result = await execa("git", args, {
    cwd,
    windowsHide: true,
    ...opts,
  });
  return typeof result.stdout === "string" ? result.stdout : "";
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Initialize a fresh product repository with an initial commit. */
export async function ensureRepo(repoPath: string): Promise<void> {
  await fsp.mkdir(repoPath, { recursive: true });
  if (!(await isGitRepo(repoPath))) {
    await git(repoPath, ["init", "-b", "main"]);
  }
  // Local identity so commits work even without global git config.
  await git(repoPath, ["config", "user.name", "Sierge"]);
  await git(repoPath, ["config", "user.email", "sierge@localhost"]);
  await git(repoPath, ["config", "core.longpaths", "true"]);

  const hasCommit = await git(repoPath, ["rev-list", "-n", "1", "--all"]).catch(
    () => "",
  );
  if (!hasCommit.trim()) {
    await git(repoPath, ["add", "-A"]);
    await git(repoPath, [
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit (created by Sierge)",
    ]);
  }
}

export function taskBranchName(taskId: string): string {
  return `sierge/task-${taskId}`;
}

export function taskWorktreePath(projectId: string, taskId: string): string {
  return path.join(worktreesRoot, projectId, taskId);
}

/**
 * Create the isolated branch + worktree for a task. Called at task creation,
 * BEFORE planning, so the plan and implementation sessions share one cwd
 * (ADR-0002 session-continuity requirement).
 */
export async function createTaskWorktree(
  repoPath: string,
  projectId: string,
  taskId: string,
): Promise<{ branchName: string; worktreePath: string }> {
  const branchName = taskBranchName(taskId);
  const wtPath = taskWorktreePath(projectId, taskId);
  await fsp.mkdir(path.dirname(wtPath), { recursive: true });
  await git(repoPath, ["worktree", "add", "-b", branchName, wtPath, "main"]);
  return { branchName, worktreePath: wtPath };
}

/** Commit any uncommitted agent work so nothing is silently lost. */
export async function checkpointWorktree(
  worktreePath: string,
  message: string,
): Promise<void> {
  const status = await git(worktreePath, ["status", "--porcelain"]);
  if (status.trim()) {
    await git(worktreePath, ["add", "-A"]);
    await git(worktreePath, ["commit", "-m", message]);
  }
}

export async function changedFiles(
  repoPath: string,
  branchName: string,
): Promise<FileChange[]> {
  const out = await git(repoPath, [
    "diff",
    "--name-status",
    `main...${branchName}`,
  ]);
  const changes: FileChange[] = [];
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const [code, ...rest] = trimmed.split("\t");
    if (!code || rest.length === 0) continue;
    const first = code.charAt(0);
    const changeType =
      first === "A"
        ? "added"
        : first === "D"
          ? "deleted"
          : first === "R"
            ? "renamed"
            : "modified";
    changes.push({
      path: (rest[rest.length - 1] ?? "").replace(/\\/g, "/"),
      changeType,
      plainDescription: null,
    });
  }
  return changes;
}

export async function diffStat(
  repoPath: string,
  branchName: string,
): Promise<string> {
  return git(repoPath, ["diff", "--stat", `main...${branchName}`]);
}

/** True if `ref` exists and is already an ancestor of `main` (i.e. merged). */
export async function isMergedIntoMain(
  repoPath: string,
  ref: string,
): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    // Branch no longer exists — it was deleted after a successful merge.
    return false;
  }
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", ref, "main"]);
    return true;
  } catch {
    return false;
  }
}

/** True if the named branch still exists. */
export async function branchExists(
  repoPath: string,
  branchName: string,
): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Merge an accepted task into main. Owner-approved path only.
 * Idempotent: if the branch is already merged (or was deleted after a prior
 * successful merge), returns main's HEAD instead of failing. Fails honestly
 * if the main checkout is dirty or the merge conflicts.
 */
export async function mergeTask(
  repoPath: string,
  branchName: string,
  message: string,
): Promise<string> {
  // Already merged (or branch gone after a prior merge) → nothing to do.
  if (!(await branchExists(repoPath, branchName))) {
    return (await git(repoPath, ["rev-parse", "main"])).trim();
  }
  if (await isMergedIntoMain(repoPath, branchName)) {
    return (await git(repoPath, ["rev-parse", "main"])).trim();
  }
  const status = await git(repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      "The main project folder has uncommitted changes. Sierge will not merge over them — resolve or discard those changes first.",
    );
  }
  await git(repoPath, ["checkout", "main"]);
  try {
    await git(repoPath, ["merge", "--no-ff", branchName, "-m", message]);
  } catch (err) {
    await git(repoPath, ["merge", "--abort"]).catch(() => {});
    throw new Error(
      `The merge could not be completed automatically: ${String(err).slice(0, 300)}`,
    );
  }
  return (await git(repoPath, ["rev-parse", "HEAD"])).trim();
}

/** Remove a task's worktree and branch (accept keeps history; discard drops it). */
export async function removeTaskWorktree(
  repoPath: string,
  projectId: string,
  taskId: string,
  deleteBranch: "keep" | "delete-merged" | "force-delete",
): Promise<void> {
  const wtPath = taskWorktreePath(projectId, taskId);
  // Idempotent: only try to remove the worktree if it still exists on disk.
  if (fs.existsSync(wtPath)) {
    await git(repoPath, ["worktree", "remove", "--force", wtPath]).catch(
      async () => {
        // Windows file locks: retry once after a short pause.
        await new Promise((r) => setTimeout(r, 1500));
        await git(repoPath, ["worktree", "remove", "--force", wtPath]).catch(
          () => {},
        );
      },
    );
  }
  // Drop any stale worktree registration left behind by a forced removal.
  await git(repoPath, ["worktree", "prune"]).catch(() => {});
  const branchName = taskBranchName(taskId);
  if (deleteBranch === "delete-merged") {
    await git(repoPath, ["branch", "-d", branchName]).catch(() => {});
  } else if (deleteBranch === "force-delete") {
    await git(repoPath, ["branch", "-D", branchName]).catch(() => {});
  }
}

/**
 * Commit Sierge's own writes to the in-repo .sierge/ docs immediately, so
 * the main checkout stays clean (a dirty main blocks merges) and every
 * owner edit / decision entry is versioned.
 */
export async function commitSiergeDocs(
  repoPath: string,
  message: string,
): Promise<void> {
  await git(repoPath, ["add", ".sierge"]);
  const staged = await git(repoPath, ["diff", "--cached", "--name-only"]);
  if (staged.trim()) {
    await git(repoPath, ["commit", "-m", message]);
  }
}

export async function mainHeadSha(repoPath: string): Promise<string> {
  return (await git(repoPath, ["rev-parse", "main"])).trim();
}

export async function gitVersion(): Promise<string | null> {
  try {
    return (await git(process.cwd(), ["--version"])).trim();
  } catch {
    return null;
  }
}
