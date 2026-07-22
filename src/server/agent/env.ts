/**
 * Explicitly constructed environment for the Claude Code subprocess
 * (ADR-0002): only what the agent needs to run — never the parent process's
 * full environment, so stray secrets (tokens, keys) in the owner's shell can
 * never reach the agent.
 *
 * Note: the SDK REPLACES the subprocess env with this object (no merging).
 */
const PASS_THROUGH = [
  // Process basics + binary resolution
  "PATH",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "COMSPEC",
  "PATHEXT",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMDATA",
  "USERNAME",
  "OS",
  "NUMBER_OF_PROCESSORS",
  // Claude Code auth/config (the agent must reuse the owner's local auth)
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
];

export function buildAgentEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of PASS_THROUGH) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "sierge/0.1.0";
  // Attribute the agent's own git commits to Sierge via env (honest
  // provenance) without touching the owner's repo config — so the owner's own
  // manual commits from that repo keep their identity, and adopted repos and
  // fresh repos behave consistently.
  env.GIT_AUTHOR_NAME = "Sierge";
  env.GIT_AUTHOR_EMAIL = "sierge@localhost";
  env.GIT_COMMITTER_NAME = "Sierge";
  env.GIT_COMMITTER_EMAIL = "sierge@localhost";
  return env;
}

// Auth/config keys the AGENT needs but Sierge-run project scripts (validation,
// preview) must never see — those scripts may be agent-authored.
const SCRIPT_EXCLUDE = new Set([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CONFIG_DIR",
]);

/**
 * Environment for scripts SIERGE ITSELF runs inside the worktree — the
 * project's own package.json test/lint/typecheck/build/dev/start scripts,
 * which the agent may have authored. Same allowlist as the agent minus the
 * Claude auth keys, so a hostile or compromised-dependency script cannot read
 * the owner's shell secrets (ADR-0002 env-isolation invariant). Pair with
 * execa's `extendEnv: false` so process.env is not merged back in.
 */
export function buildScriptEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {};
  for (const key of PASS_THROUGH) {
    if (SCRIPT_EXCLUDE.has(key)) continue;
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}
