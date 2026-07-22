import path from "node:path";
import { execa } from "execa";
import { readJson, writeFileAtomic } from "./fsStore.js";
import { taskDataDir } from "./config.js";
import type { ValidationCheck, ValidationReport } from "../shared/types.js";

/**
 * Validation truth comes from Sierge, never from the agent: Sierge runs the
 * project's own scripts and records real exit codes. A missing script is
 * "unavailable" — it is NEVER presented as passed (ADR-0002).
 */

const CHECKS = ["test", "lint", "typecheck", "build"] as const;
const CHECK_TIMEOUT_MS = 10 * 60 * 1000;

export async function runValidation(
  worktreePath: string,
  projectId: string,
  taskId: string,
  fixRound: number,
): Promise<ValidationReport> {
  const pkg = await readJson<{ scripts?: Record<string, string> }>(
    path.join(worktreePath, "package.json"),
    {},
  );
  const scripts = pkg.scripts ?? {};
  const checks: ValidationCheck[] = [];

  for (const name of CHECKS) {
    if (!scripts[name]) {
      checks.push({
        name,
        command: null,
        status: "unavailable",
        exitCode: null,
        durationMs: null,
        logTail: null,
      });
      continue;
    }

    const command = `npm run ${name}`;
    const started = Date.now();
    let exitCode: number | null = null;
    let output = "";
    try {
      const result = await execa(command, {
        cwd: worktreePath,
        shell: true,
        all: true,
        reject: false,
        timeout: CHECK_TIMEOUT_MS,
        windowsHide: true,
        env: { ...process.env, CI: "true", FORCE_COLOR: "0" },
      });
      exitCode = result.exitCode ?? null;
      output = typeof result.all === "string" ? result.all : "";
      if (result.timedOut) {
        output += "\n[Sierge] Check timed out and was stopped.";
        exitCode = exitCode ?? 124;
      }
    } catch (err) {
      output = String(err);
      exitCode = -1;
    }
    const durationMs = Date.now() - started;

    const logFile = path.join(
      taskDataDir(projectId, taskId),
      "logs",
      `${name}-round${fixRound}.log`,
    );
    await writeFileAtomic(logFile, output);

    checks.push({
      name,
      command,
      status: exitCode === 0 ? "passed" : "failed",
      exitCode,
      durationMs,
      logTail: output.length > 4000 ? "…" + output.slice(-4000) : output,
    });
  }

  const available = checks.filter((c) => c.status !== "unavailable");
  const overall =
    available.length === 0
      ? "none"
      : available.some((c) => c.status === "failed")
        ? "failed"
        : available.length === CHECKS.length
          ? "passed"
          : "partial";

  return { checks, overall, ranAt: new Date().toISOString(), fixRound };
}
