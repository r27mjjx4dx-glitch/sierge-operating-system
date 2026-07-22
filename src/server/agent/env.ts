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
  return env;
}
