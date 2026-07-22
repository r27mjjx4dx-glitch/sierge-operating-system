import os from "node:os";
import path from "node:path";

export const SERVER_PORT = Number(process.env.SIERGE_PORT ?? 4680);
export const SERVER_HOST = "127.0.0.1"; // loopback only — never internet-facing

/**
 * Machine-generated state lives OUTSIDE any product repository so that agent
 * activity can never appear in the owner's diffs and the agent (whose cwd is
 * always a worktree) can never reach it.
 */
export const dataRoot =
  process.env.SIERGE_DATA_DIR ??
  path.join(
    process.env.LOCALAPPDATA ?? path.join(os.homedir(), ".local", "share"),
    "Sierge",
  );

export const registryPath = path.join(dataRoot, "registry.json");
export const worktreesRoot = path.join(dataRoot, "worktrees");
export const tasksDataRoot = path.join(dataRoot, "projects");
export const selftestCachePath = path.join(dataRoot, "selftest.json");

/** Default location for newly created product repositories. */
export const defaultProjectsHome = path.join(os.homedir(), "SiergeProjects");

/** Blocking approval cards time out to DENY after this long. */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;

/** Validation failures feed back into at most this many visible fix rounds. */
export const MAX_AUTOFIX_ROUNDS = 2;

/** Per-phase hard timeout for agent queries (safety net, not a target). */
export const AGENT_PHASE_TIMEOUT_MS = 30 * 60 * 1000;

export function taskDataDir(projectId: string, taskId: string): string {
  return path.join(tasksDataRoot, projectId, "tasks", taskId);
}

export function projectDataDir(projectId: string): string {
  return path.join(tasksDataRoot, projectId);
}
