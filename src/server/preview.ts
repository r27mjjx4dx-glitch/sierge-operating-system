import path from "node:path";
import { execa, type ResultPromise } from "execa";
import getPort from "get-port";
import treeKill from "tree-kill";
import { readJson } from "./fsStore.js";
import { buildScriptEnv } from "./agent/env.js";
import type { PreviewState } from "../shared/types.js";

/**
 * Controlled local preview: Sierge spawns the project's own dev/start script
 * inside the task worktree on a free port, health-polls before showing the
 * link, and tree-kills the whole process tree on stop (Windows-safe).
 * If no runnable script exists or the server never answers, the state is an
 * honest "unavailable"/"failed" — never a fake success.
 */

interface Running {
  proc: ResultPromise;
  pid: number;
  state: PreviewState;
}

const running = new Map<string, Running>();

async function killTree(pid: number): Promise<void> {
  await new Promise<void>((resolve) => treeKill(pid, "SIGTERM", () => resolve()));
  await new Promise((r) => setTimeout(r, 500));
  await new Promise<void>((resolve) => treeKill(pid, "SIGKILL", () => resolve()));
}

export function getPreview(taskId: string): PreviewState {
  return (
    running.get(taskId)?.state ?? {
      status: "stopped",
      url: null,
      detail: null,
    }
  );
}

export async function stopPreview(taskId: string): Promise<PreviewState> {
  const entry = running.get(taskId);
  if (entry) {
    await killTree(entry.pid).catch(() => {});
    running.delete(taskId);
  }
  return { status: "stopped", url: null, detail: null };
}

export async function startPreview(
  taskId: string,
  worktreePath: string,
): Promise<PreviewState> {
  await stopPreview(taskId);

  const pkg = await readJson<{ scripts?: Record<string, string> }>(
    path.join(worktreePath, "package.json"),
    {},
  );
  const scripts = pkg.scripts ?? {};
  const script = scripts.dev ? "dev" : scripts.start ? "start" : null;
  if (!script) {
    return {
      status: "unavailable",
      url: null,
      detail:
        "This project has no runnable preview (no \"dev\" or \"start\" script). You can still review the changes and validation evidence.",
    };
  }

  const port = await getPort();
  // Suggest the port via PORT, but do NOT assume the tool honors it — Vite and
  // others bind their own default. We also scan the child's output for the URL
  // it actually announces and health-check that.
  const proc = execa(`npm run ${script}`, {
    cwd: worktreePath,
    shell: true,
    windowsHide: true,
    reject: false,
    all: true,
    extendEnv: false,
    env: { ...buildScriptEnv(), PORT: String(port), BROWSER: "none", FORCE_COLOR: "0" },
  });
  if (proc.pid === undefined) {
    return { status: "failed", url: null, detail: "The preview process could not start." };
  }
  let exited = false;
  void proc.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );

  // Detected URL from the dev server's own output (e.g. Vite "Local: http://…").
  let announcedUrl: string | null = null;
  const scan = (chunk: unknown) => {
    const text = String(chunk);
    const m = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):(\d+)\/?/i);
    if (m) announcedUrl = `http://127.0.0.1:${m[1]}/`;
  };
  proc.all?.on("data", scan);

  const suggestedUrl = `http://127.0.0.1:${port}/`;
  const entry: Running = {
    proc,
    pid: proc.pid,
    state: { status: "starting", url: null, detail: `Starting "${script}" script…` },
  };
  running.set(taskId, entry);

  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    // Prefer the URL the tool announced; fall back to the suggested port.
    for (const candidate of announcedUrl
      ? [announcedUrl, suggestedUrl]
      : [suggestedUrl]) {
      try {
        const res = await fetch(candidate, { signal: AbortSignal.timeout(1500) });
        void res; // any HTTP answer (even 404) means a server is listening
        entry.state = { status: "ready", url: candidate, detail: null };
        return entry.state;
      } catch {
        // try the next candidate / poll again
      }
    }
    if (exited) break;
    await new Promise((r) => setTimeout(r, 750));
  }

  await stopPreview(taskId);
  return {
    status: "failed",
    url: null,
    detail:
      "The preview server did not answer in time. It may need settings (like environment variables) that aren't available. The change can still be reviewed from the evidence below.",
  };
}

export async function stopAllPreviews(): Promise<void> {
  for (const taskId of [...running.keys()]) {
    await stopPreview(taskId);
  }
}
