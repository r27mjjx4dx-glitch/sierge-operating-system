import path from "node:path";
import os from "node:os";
import { existsSync } from "./fsStore.js";
import { gitVersion } from "./gitManager.js";
import { getCachedSelfTest } from "./policy/selftest.js";
import type { PreflightReport } from "../shared/types.js";

export async function runPreflight(): Promise<PreflightReport> {
  const checks: PreflightReport["checks"] = [];

  const git = await gitVersion();
  checks.push({
    name: "Git",
    ok: git !== null,
    detail:
      git ??
      "Git was not found. Install 'Git for Windows' from git-scm.com, then restart Sierge.",
  });

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "Node.js",
    ok: nodeMajor >= 20,
    detail: `Node ${process.versions.node}${nodeMajor >= 20 ? "" : " — Sierge needs Node 20 or newer."}`,
  });

  const hasApiKey = Boolean(
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
  );
  const claudeDir =
    process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), ".claude");
  const hasClaudeConfig = existsSync(claudeDir);
  checks.push({
    name: "Claude account",
    ok: hasApiKey || hasClaudeConfig,
    detail:
      hasApiKey || hasClaudeConfig
        ? "Claude sign-in detected on this machine."
        : "No Claude sign-in found. Sign in to Claude Code once (run 'claude' in a terminal), then restart Sierge.",
  });

  const cached = await getCachedSelfTest();
  const selfTest: PreflightReport["selfTest"] = cached
    ? { status: cached.status, detail: cached.detail }
    : {
        status: "not_run",
        detail:
          "The one-time safety self-test runs automatically before the first task.",
      };

  return {
    ok: checks.every((c) => c.ok) && selfTest.status !== "failed",
    checks,
    selfTest,
  };
}
