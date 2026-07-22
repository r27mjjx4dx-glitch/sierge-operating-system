import path from "node:path";

/**
 * Narration layer: translate raw tool calls into plain language for the
 * owner's live activity feed. Curated mapping only (no LLM in v1); the raw
 * event is always retained alongside for the disclosure view.
 */

function rel(worktree: string, p: string | undefined): string {
  if (!p) return "a file";
  try {
    const r = path.relative(worktree, path.resolve(worktree, p));
    return r && !r.startsWith("..") ? r.replace(/\\/g, "/") : path.basename(p);
  } catch {
    return path.basename(p);
  }
}

function describeCommand(command: string): string {
  const cmd = command.trim();
  if (/^(npm|pnpm|yarn)\s+(run\s+)?test/i.test(cmd)) return "Running the tests";
  if (/^(npm|pnpm|yarn)\s+run\s+lint/i.test(cmd)) return "Checking code style";
  if (/^(npm|pnpm|yarn)\s+run\s+build/i.test(cmd)) return "Building the app";
  if (/^(npm|pnpm|yarn)\s+run\s+(\S+)/i.test(cmd)) {
    const m = cmd.match(/run\s+(\S+)/i);
    return `Running the "${m?.[1]}" script`;
  }
  if (/^(npm|pnpm|yarn)\s+(install|ci)\b/i.test(cmd))
    return "Installing project dependencies";
  if (/^git\s+add/i.test(cmd)) return "Staging changed files";
  if (/^git\s+commit/i.test(cmd)) return "Saving a checkpoint of the work";
  if (/^git\s+(status|diff|log|show)/i.test(cmd)) return "Reviewing the work so far";
  if (/^(tsc|npx\s+tsc)\b/i.test(cmd)) return "Checking the code for type errors";
  if (/^node\s+/i.test(cmd)) return "Running a script";
  if (/^(mkdir|md)\b/i.test(cmd)) return "Creating a folder";
  if (/^(ls|dir|cat|type|head|tail|findstr|grep)\b/i.test(cmd))
    return "Looking through project files";
  const first = cmd.split(/\s+/)[0] ?? "a command";
  return `Running: ${first}`;
}

export function narrate(
  tool: string,
  input: unknown,
  worktree: string,
): string {
  const rec =
    typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)
      : {};
  const filePath = typeof rec.file_path === "string" ? rec.file_path : undefined;

  switch (tool) {
    case "Read":
      return `Reading ${rel(worktree, filePath)}`;
    case "Glob":
      return "Scanning the project structure";
    case "Grep":
      return "Searching the code";
    case "Edit":
    case "MultiEdit":
      return `Updating ${rel(worktree, filePath)}`;
    case "Write":
      return `Writing ${rel(worktree, filePath)}`;
    case "NotebookEdit":
      return `Updating a notebook`;
    case "Bash":
    case "PowerShell":
    case "Shell":
      return describeCommand(typeof rec.command === "string" ? rec.command : "");
    case "WebFetch":
      return "Wants to fetch a web page";
    case "WebSearch":
      return "Wants to search the web";
    case "TodoWrite":
      return "Organizing its task list";
    case "AskUserQuestion":
      return "Has a question for you";
    case "Task":
      return "Delegating a sub-task";
    default:
      return `Using tool: ${tool}`;
  }
}

/** Safe, truncated rendering of tool input for the audit log / disclosure. */
export function summarizeInput(input: unknown): string {
  let raw: string;
  try {
    raw = JSON.stringify(input) ?? "null";
  } catch {
    raw = String(input);
  }
  return raw.length > 600 ? raw.slice(0, 600) + "…" : raw;
}
