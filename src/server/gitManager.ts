import fs from "node:fs";
import path from "node:path";
import fsp from "node:fs/promises";
import { execa, type Options as ExecaOptions } from "execa";
import { worktreesRoot } from "./config.js";
import type { FileChange } from "../shared/types.js";

/**
 * All git operations in Sierge go through this module, and the merge into the
 * owner's accepted state (the default branch) exists ONLY here — the agent is
 * never granted merge/push/tag capability (those commands are hard-denied by
 * policy). Sierge's own commits are attributed to a Sierge identity via
 * per-invocation env, so the owner's repository git config is never mutated.
 */

const DEFAULT_BRANCH_FALLBACK = "main";

/** Identity for commits Sierge itself makes; never written to repo config. */
const SIERGE_COMMIT_ENV: Record<string, string> = {
  GIT_AUTHOR_NAME: "Sierge",
  GIT_AUTHOR_EMAIL: "sierge@localhost",
  GIT_COMMITTER_NAME: "Sierge",
  GIT_COMMITTER_EMAIL: "sierge@localhost",
};

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

/** A commit attributed to Sierge without touching the repo's git config. */
async function gitCommitAsSierge(cwd: string, args: string[]): Promise<string> {
  return git(cwd, args, { env: { ...process.env, ...SIERGE_COMMIT_ENV } });
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await git(dir, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Whether a commit identity is resolvable (repo or global config). */
async function hasGitIdentity(repoPath: string): Promise<boolean> {
  const email = await git(repoPath, ["config", "user.email"]).catch(() => "");
  return Boolean(email.trim());
}

/** The repository's current branch (its "default" for Sierge's purposes). */
export async function detectDefaultBranch(repoPath: string): Promise<string> {
  const branch = (
    await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]).catch(() => "")
  ).trim();
  if (!branch || branch === "HEAD") {
    throw new Error(
      "This repository has no checked-out branch (detached HEAD). Check out a branch, then add it to Sierge.",
    );
  }
  return branch;
}

/** True if the working tree has no uncommitted changes (tracked or untracked). */
export async function isWorkingTreeClean(repoPath: string): Promise<boolean> {
  const status = await git(repoPath, ["status", "--porcelain"]);
  return !status.trim();
}

/**
 * True if the index has staged changes. Sierge's setup commit stages only
 * `.sierge/` but `git commit` commits the whole index, so pre-staged owner
 * work would be swept in — this is the specific condition to refuse on when
 * adopting a repo. Untracked and modified-unstaged files are safe (never
 * committed by a scoped add).
 */
export async function hasStagedChanges(repoPath: string): Promise<boolean> {
  const staged = await git(repoPath, ["diff", "--cached", "--name-only"]);
  return Boolean(staged.trim());
}

/**
 * Ensure a git repo exists and can accept Sierge's commits. For an existing
 * repository this is minimally invasive: it never overwrites an existing git
 * identity and never creates commits here (the caller decides what to commit).
 * Returns the repository's default branch.
 */
export async function ensureRepo(repoPath: string): Promise<string> {
  await fsp.mkdir(repoPath, { recursive: true });
  const preexisting = await isGitRepo(repoPath);
  if (!preexisting) {
    await git(repoPath, ["init", "-b", DEFAULT_BRANCH_FALLBACK]);
  }
  // Long-path support helps on Windows; harmless and non-identity config.
  await git(repoPath, ["config", "core.longpaths", "true"]).catch(() => {});
  // Only set a repo-LOCAL identity when none is resolvable, so we never change
  // the owner's configured authorship. (Sierge's own commits override via env.)
  if (!(await hasGitIdentity(repoPath))) {
    await git(repoPath, ["config", "user.name", "Sierge"]);
    await git(repoPath, ["config", "user.email", "sierge@localhost"]);
  }

  const hasCommit = await git(repoPath, ["rev-list", "-n", "1", "--all"]).catch(
    () => "",
  );
  if (!hasCommit.trim()) {
    // Brand-new empty repo: seed an initial commit so worktrees have a base.
    await gitCommitAsSierge(repoPath, [
      "commit",
      "--allow-empty",
      "-m",
      "Initial commit (created by Sierge)",
    ]);
  }
  return preexisting
    ? detectDefaultBranch(repoPath)
    : DEFAULT_BRANCH_FALLBACK;
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
  baseBranch: string = DEFAULT_BRANCH_FALLBACK,
): Promise<{ branchName: string; worktreePath: string }> {
  const branchName = taskBranchName(taskId);
  const wtPath = taskWorktreePath(projectId, taskId);
  await fsp.mkdir(path.dirname(wtPath), { recursive: true });
  await git(repoPath, ["worktree", "add", "-b", branchName, wtPath, baseBranch]);
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
    await gitCommitAsSierge(worktreePath, ["commit", "-m", message]);
  }
}

export async function changedFiles(
  repoPath: string,
  branchName: string,
  baseBranch: string = DEFAULT_BRANCH_FALLBACK,
): Promise<FileChange[]> {
  const out = await git(repoPath, [
    "diff",
    "--name-status",
    `${baseBranch}...${branchName}`,
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
  baseBranch: string = DEFAULT_BRANCH_FALLBACK,
): Promise<string> {
  return git(repoPath, ["diff", "--stat", `${baseBranch}...${branchName}`]);
}

/** True if `ref` exists and is already an ancestor of `targetBranch` (merged). */
export async function isMergedIntoMain(
  repoPath: string,
  ref: string,
  targetBranch: string = DEFAULT_BRANCH_FALLBACK,
): Promise<boolean> {
  try {
    await git(repoPath, ["rev-parse", "--verify", `${ref}^{commit}`]);
  } catch {
    // Branch no longer exists — it was deleted after a successful merge.
    return false;
  }
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", ref, targetBranch]);
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
 * Merge an accepted task into the default branch. Owner-approved path only.
 * Idempotent: if the branch is already merged (or was deleted after a prior
 * successful merge), returns the default branch's HEAD instead of failing.
 * Fails honestly if the default-branch checkout is dirty or the merge conflicts.
 * The merge commit is attributed to Sierge (never the owner).
 */
export async function mergeTask(
  repoPath: string,
  branchName: string,
  message: string,
  targetBranch: string = DEFAULT_BRANCH_FALLBACK,
): Promise<string> {
  // Already merged (or branch gone after a prior merge) → nothing to do.
  if (!(await branchExists(repoPath, branchName))) {
    return (await git(repoPath, ["rev-parse", targetBranch])).trim();
  }
  if (await isMergedIntoMain(repoPath, branchName, targetBranch)) {
    return (await git(repoPath, ["rev-parse", targetBranch])).trim();
  }
  const status = await git(repoPath, ["status", "--porcelain"]);
  if (status.trim()) {
    throw new Error(
      `The project's "${targetBranch}" branch has uncommitted changes. Sierge will not merge over them — resolve or discard those changes first.`,
    );
  }
  await git(repoPath, ["checkout", targetBranch]);
  try {
    await gitCommitAsSierge(repoPath, ["merge", "--no-ff", branchName, "-m", message]);
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
    await gitCommitAsSierge(repoPath, ["commit", "-m", message]);
  }
}

export async function mainHeadSha(
  repoPath: string,
  branch: string = DEFAULT_BRANCH_FALLBACK,
): Promise<string> {
  return (await git(repoPath, ["rev-parse", branch])).trim();
}

export async function gitVersion(): Promise<string | null> {
  try {
    return (await git(process.cwd(), ["--version"])).trim();
  } catch {
    return null;
  }
}
