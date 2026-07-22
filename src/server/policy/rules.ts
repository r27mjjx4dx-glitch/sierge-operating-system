import path from "node:path";

/**
 * Pure, unit-testable policy classification. No IO, no SDK types.
 *
 * Order of evaluation (mirrors ADR-0002):
 *   1. hard denies  — irreversible/external/dangerous actions, out-of-scope
 *                     paths, secret files, Sierge's own metadata
 *   2. auto-allows  — routine work inside the isolated worktree
 *   3. everything else -> ask the owner (deny on timeout, handled by engine)
 */

export type RuleAction = "allow" | "deny" | "ask";

export interface Ruling {
  action: RuleAction;
  rule: string;
  reason: string;
}

export interface PolicyContext {
  /** Absolute path of the task worktree; the only writable universe. */
  worktreePath: string;
  phase: "plan" | "implement" | "summarize";
}

const deny = (rule: string, reason: string): Ruling => ({
  action: "deny",
  rule,
  reason,
});
const allow = (rule: string, reason: string): Ruling => ({
  action: "allow",
  rule,
  reason,
});
const ask = (rule: string, reason: string): Ruling => ({
  action: "ask",
  rule,
  reason,
});

// ---------------------------------------------------------------------------
// Path helpers (Windows-aware: case-insensitive, both slash styles)
// ---------------------------------------------------------------------------

function normalize(p: string): string {
  return path.resolve(p).replace(/[\\/]+/g, "\\").toLowerCase();
}

export function isInside(child: string, parent: string): boolean {
  const c = normalize(child);
  const p = normalize(parent);
  return c === p || c.startsWith(p.endsWith("\\") ? p : p + "\\");
}

const SECRET_PATTERNS: RegExp[] = [
  /(^|[\\/])\.env($|\.)/i,
  /\.pem$/i,
  /\.key$/i,
  /(^|[\\/])id_rsa/i,
  /(^|[\\/])id_ed25519/i,
  /credential/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /(^|[\\/])secrets?\.(json|ya?ml|toml|txt)$/i,
  /(^|[\\/])\.aws([\\/]|$)/i,
  /(^|[\\/])\.ssh([\\/]|$)/i,
  /(^|[\\/])\.netrc$/i,
];

export function isSecretPath(p: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(p));
}

export function isSiergeMetadataPath(p: string): boolean {
  return /(^|[\\/])\.sierge([\\/]|$)/i.test(p);
}

/** Resolve a possibly-relative tool path against the worktree. */
function resolveAgainst(worktree: string, p: string): string {
  return path.isAbsolute(p) ? p : path.join(worktree, p);
}

// ---------------------------------------------------------------------------
// Bash command classification
// ---------------------------------------------------------------------------

const HARD_DENY_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\bgit\s+push\b/i, reason: "Pushing to a remote is owner-only." },
  { re: /\bgit\s+merge\b/i, reason: "Merging is performed by Sierge after owner acceptance." },
  { re: /\bgit\s+rebase\b/i, reason: "History rewriting is not allowed." },
  { re: /\bgit\s+tag\b/i, reason: "Tagging releases is owner-only." },
  { re: /\bgit\s+remote\b/i, reason: "Changing remotes is not allowed." },
  { re: /\bgit\s+reset\s+--hard\b/i, reason: "Hard resets are destructive." },
  { re: /\bgit\s+clean\b/i, reason: "git clean is destructive." },
  { re: /\bgit\s+branch\s+(-d|-D)\b/i, reason: "Branch deletion is managed by Sierge." },
  { re: /\bgit\s+worktree\b/i, reason: "Worktrees are managed by Sierge." },
  { re: /\bgit\s+config\s+--global\b/i, reason: "Global git configuration is off-limits." },
  { re: /\bgit\s+credential\b/i, reason: "Credential access is off-limits." },
  { re: /\b(npm|yarn|pnpm)\s+publish\b/i, reason: "Publishing packages is owner-only." },
  { re: /\bdocker\s+(push|login)\b/i, reason: "Registry operations are owner-only." },
  { re: /\b(vercel|netlify|heroku|flyctl|fly|wrangler|amplify)\b/i, reason: "Deploy CLIs are blocked; deployment is out of scope." },
  { re: /\b(aws|az|gcloud|kubectl|terraform|pulumi)\b/i, reason: "Cloud/infra CLIs are blocked." },
  { re: /\bfirebase\s+deploy\b/i, reason: "Deploy CLIs are blocked." },
  // Recursive/forced deletes — order-insensitive, POSIX + cmd + PowerShell aliases.
  { re: /\brm\s+(-[a-z]*r[a-z]*f?|-[a-z]*f[a-z]*r|--recursive|--force)/i, reason: "Recursive/forced deletion is blocked." },
  { re: /\b(rmdir|rd)\b[^|;&\n]*\s\/s\b/i, reason: "Recursive deletion is blocked." },
  { re: /\bdel\s+\/[fsq]\b/i, reason: "Forced deletion is blocked." },
  // Remove-Item and its aliases (ri, rd, del, erase, rm, rmdir) with -Recurse / -r abbreviations.
  { re: /\b(remove-item|ri|rd|del|erase|rmdir)\b[^|;&\n]*\s-r(?:e(?:c(?:u(?:r(?:s(?:e)?)?)?)?)?)?\b/i, reason: "Recursive deletion is blocked." },
  // Piped enumerate-then-delete: `Get-ChildItem -Recurse | Remove-Item`.
  { re: /-recurse\b[^\n]*\|[^\n]*\b(remove-item|ri|del|rd|erase|rmdir)\b/i, reason: "Recursive deletion is blocked." },
  { re: /\bformat\s+[a-z]:/i, reason: "Disk operations are blocked." },
  { re: /\bssh(-add|-keygen|-agent)?\b/i, reason: "SSH/credential tooling is off-limits." },
  { re: /\bgh\s+auth\b/i, reason: "Credential tooling is off-limits." },
  { re: /\b(setx|reg)\s/i, reason: "System configuration changes are blocked." },
  { re: /\bschtasks\b/i, reason: "Scheduled-task changes are blocked." },
  { re: /\bshutdown\b/i, reason: "System power commands are blocked." },
  // Opaque / dynamic execution defeats even human review — block outright.
  { re: /\bpowershell(\.exe)?\b[^|;&\n]*\s-e(nc(odedcommand)?)?\b/i, reason: "Encoded PowerShell commands are blocked; they can't be reviewed." },
  { re: /\b(iex|invoke-expression)\b/i, reason: "Dynamic command evaluation (Invoke-Expression) is blocked." },
];

const ASK_COMMAND_PATTERNS: Array<{ re: RegExp; reason: string }> = [
  { re: /\b(curl|wget|invoke-webrequest|iwr|invoke-restmethod|irm|scp|ftp)\b/i, reason: "Network access needs owner approval." },
  { re: /\b(npm|pnpm|yarn)\s+(install|i|add)\s+\S/i, reason: "Adding a new dependency needs owner approval." },
  { re: /\bnpx\s+(?!tsc\b|vitest\b|jest\b|eslint\b|prettier\b|vite\b)/i, reason: "Running an arbitrary package needs owner approval." },
];

const ALLOW_COMMAND_PATTERNS: RegExp[] = [
  /^(npm|pnpm|yarn)\s+(run\s+\S+|test|ci|install)\s*$/i,
  /^(npm|pnpm|yarn)\s+run\s+\S+(\s+--\s+.*)?$/i,
  /^npx\s+(tsc|vitest|jest|eslint|prettier|vite)\b.*$/i,
  /^(tsc|vitest|jest|eslint|prettier)\b.*$/i,
  /^node\s+\S+.*$/i,
  /^git\s+(add|commit|status|diff|log|show|stash|restore)\b.*$/i,
  /^(ls|dir|cat|type|pwd|cd|mkdir|echo|findstr|grep|head|tail|wc|copy|cp|move|mv|ren)\b.*$/i,
  /^where\s+\S+$/i,
  /^set\s*$/i,
  // Harmless PowerShell cmdlets (read/inspect only; writes use Write/Edit tools)
  /^(get-childitem|get-content|get-item|get-location|test-path|select-string|measure-object|write-output|write-host)\b.*$/i,
  /^new-item\s+.*-itemtype\s+directory\b.*$/i,
];

/** Extract absolute-path-looking tokens from a shell command. */
function absolutePathTokens(command: string): string[] {
  const tokens: string[] = [];
  const winPaths = command.match(/(?<![A-Za-z0-9])[A-Za-z]:[\\/][^\s"'<>|;&]*/g);
  if (winPaths) tokens.push(...winPaths);
  const gitBashPaths = command.match(/(?<=\s|^)\/(?:[a-z])\/[^\s"'<>|;&]*/g);
  if (gitBashPaths)
    tokens.push(
      ...gitBashPaths.map((p) => `${p.charAt(1).toUpperCase()}:${p.slice(2)}`),
    );
  // UNC network paths (\\server\share, //server/share) — always outside the
  // worktree, so isInside() will deny them. The `:` in the lookbehind avoids
  // matching the `//` inside URLs (http://…), which are routed to ASK instead.
  const uncPaths = command.match(/(?<![A-Za-z0-9:])(?:\\\\|\/\/)[^\s"'<>|;&]+/g);
  if (uncPaths) tokens.push(...uncPaths);
  // Drive-relative paths (C:file, no slash) — resolve against the drive's cwd,
  // not the worktree; treat as out-of-worktree.
  const driveRel = command.match(/(?<![A-Za-z0-9])[A-Za-z]:(?![\\/])[^\s"'<>|;&]+/g);
  if (driveRel) tokens.push(...driveRel);
  return tokens;
}

/**
 * git accepts global options before the subcommand (`git -C . push`,
 * `git -c k=v merge`, `git --no-pager reset --hard`). Collapse those so the
 * deny/allow patterns see the subcommand right after `git`.
 */
function canonicalizeGit(command: string): string {
  return command.replace(
    /\bgit\s+((?:(?:-C\s+\S+|-c\s+\S+|--exec-path(?:=\S+)?|--git-dir(?:=\S+)?|--work-tree(?:=\S+)?|--namespace(?:=\S+)?|-p|--paginate|--no-pager|--bare|--no-replace-objects|--literal-pathspecs|--(?:no-?)?glob-pathspecs|--icase-pathspecs|--no-optional-locks)\s+)+)/gi,
    "git ",
  );
}

/**
 * Collapse shell obfuscation that reassembles at execution time — empty quote
 * pairs (`g""it`), caret escapes (`g^it`), stray backticks — so hard-deny
 * patterns can't be evaded by splitting a keyword. Used only for MATCHING;
 * the original command is what runs.
 */
function deobfuscate(command: string): string {
  return command
    .replace(/(["'`])\1/g, "")
    .replace(/\^/g, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

const TRAVERSAL_SEGMENT = /(^|[\\/])\.\.([\\/]|$)/;

function classifyBash(command: string, ctx: PolicyContext): Ruling {
  const cmd = command.trim();

  // 1. Hard denies — checked against the raw string AND de-obfuscated /
  //    git-canonicalized variants so quote/caret splitting and git global
  //    options can't smuggle a denied command past the regexes.
  const deob = deobfuscate(cmd);
  const matchTargets = [
    cmd,
    deob,
    canonicalizeGit(cmd),
    canonicalizeGit(deob),
  ];
  for (const { re, reason } of HARD_DENY_COMMAND_PATTERNS) {
    if (matchTargets.some((t) => re.test(t)))
      return deny(`bash:${re.source}`, reason);
  }

  // Path containment: every absolute/UNC/drive-relative token, and every
  // relative token that traverses upward (`..`), must resolve inside the
  // worktree. Also block secret and .sierge references. Traversal tokens are
  // skipped for a leading `git` (git can't write outside its repo via an
  // argument or commit message, and messages legitimately contain `../`).
  const isGitLead = /^git\b/i.test(cmd);
  const pathTokens = [
    ...absolutePathTokens(cmd),
    ...(isGitLead
      ? []
      : cmd
          .split(/\s+/)
          .map((raw) => raw.replace(/^["'`]+|["'`]+$/g, ""))
          .filter((t) => t && !t.startsWith("-") && TRAVERSAL_SEGMENT.test(t))),
  ];
  for (const token of pathTokens) {
    if (isSecretPath(token))
      return deny("bash:secret-path", "The command touches a credential/secret file.");
    if (isSiergeMetadataPath(token))
      return deny(
        "bash:sierge-metadata",
        "Sierge's own context/metadata files are read-only for the agent.",
      );
    if (!isInside(resolveAgainst(ctx.worktreePath, token), ctx.worktreePath))
      return deny(
        "bash:path-outside-worktree",
        `The command references a path outside the task workspace: ${token}`,
      );
  }

  // Relative secret/metadata references without traversal (e.g. `cat .env`).
  for (const raw of cmd.split(/\s+/)) {
    const token = raw.replace(/^["'`]+|["'`]+$/g, "");
    if (!token || token.startsWith("-")) continue;
    if (isSecretPath(token))
      return deny("bash:secret-path", "The command touches a credential/secret file.");
    if (isSiergeMetadataPath(token))
      return deny(
        "bash:sierge-metadata",
        "Sierge's own context/metadata files are read-only for the agent.",
      );
  }

  // Redirection into secret / metadata / out-of-worktree targets — every
  // redirect in the command, quoted or bare.
  const redirectRe = /(?:>{1,2})\s*(?:"([^"]+)"|'([^']+)'|([^\s"'|;&]+))/g;
  for (let m = redirectRe.exec(cmd); m !== null; m = redirectRe.exec(cmd)) {
    const raw = m[1] ?? m[2] ?? m[3];
    if (!raw) continue;
    const target = resolveAgainst(ctx.worktreePath, raw);
    if (isSecretPath(target))
      return deny("bash:redirect-secret", "Writing to a secret file is blocked.");
    if (isSiergeMetadataPath(target))
      return deny("bash:redirect-sierge", "Writing to Sierge metadata is blocked.");
    if (!isInside(target, ctx.worktreePath))
      return deny(
        "bash:redirect-outside",
        "Writing outside the task workspace is blocked.",
      );
  }

  // 2. Ask patterns.
  for (const { re, reason } of ASK_COMMAND_PATTERNS) {
    if (re.test(cmd)) return ask(`bash:${re.source}`, reason);
  }

  // 3. Allow list. For chained commands every segment must be allowed;
  //    git segments are canonicalized so `git -C . status` still allows.
  const segments = cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => canonicalizeGit(s.trim()))
    .filter(Boolean);
  if (
    segments.length > 0 &&
    segments.every((seg) => ALLOW_COMMAND_PATTERNS.some((re) => re.test(seg)))
  ) {
    return allow("bash:allowlist", "Routine development command.");
  }

  return ask("bash:unclassified", "Unrecognized command — owner approval required.");
}

// ---------------------------------------------------------------------------
// Tool-level classification
// ---------------------------------------------------------------------------

const WRITE_TOOLS = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);
const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);
const HARMLESS_TOOLS = new Set(["TodoWrite", "Task", "ExitPlanMode"]);

function pathsFromInput(tool: string, input: unknown): string[] {
  if (typeof input !== "object" || input === null) return [];
  const rec = input as Record<string, unknown>;
  const keys = ["file_path", "notebook_path", "path", "cwd"];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof rec[k] === "string") out.push(rec[k] as string);
  }
  return out;
}

export function decide(
  tool: string,
  input: unknown,
  ctx: PolicyContext,
): Ruling {
  // --- writes -------------------------------------------------------------
  if (WRITE_TOOLS.has(tool)) {
    if (ctx.phase === "plan") {
      return deny("plan:read-only", "Planning is read-only; no files may change.");
    }
    const paths = pathsFromInput(tool, input);
    if (paths.length === 0) {
      return ask("write:no-path", "File change with no recognizable path.");
    }
    for (const p of paths) {
      const abs = resolveAgainst(ctx.worktreePath, p);
      if (isSiergeMetadataPath(abs))
        return deny(
          "write:sierge-metadata",
          "Sierge's context, decisions, and audit files are read-only for the agent.",
        );
      if (isSecretPath(abs))
        return deny("write:secret", "Credential/secret files may not be changed.");
      if (!isInside(abs, ctx.worktreePath))
        return deny(
          "write:outside-worktree",
          `File is outside the task workspace: ${p}`,
        );
    }
    return allow("write:in-worktree", "File change inside the isolated workspace.");
  }

  // --- reads --------------------------------------------------------------
  if (READ_TOOLS.has(tool)) {
    const paths = pathsFromInput(tool, input);
    for (const p of paths) {
      const abs = resolveAgainst(ctx.worktreePath, p);
      if (isSecretPath(abs))
        return deny("read:secret", "Credential/secret files may not be read.");
      if (!isInside(abs, ctx.worktreePath))
        return deny(
          "read:outside-worktree",
          `Reading outside the task workspace is blocked: ${p}`,
        );
    }
    return allow("read:in-worktree", "Reading inside the isolated workspace.");
  }

  // --- shell (Bash on POSIX builds, PowerShell on Windows builds) ---------
  const SHELL_TOOLS = new Set(["Bash", "PowerShell", "Shell"]);
  if (
    SHELL_TOOLS.has(tool) ||
    tool === "BashOutput" ||
    tool === "KillShell"
  ) {
    if (!SHELL_TOOLS.has(tool)) return allow("bash:aux", "Shell bookkeeping.");
    const rec =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)
        : {};
    const command = typeof rec.command === "string" ? rec.command : "";
    if (ctx.phase === "plan") {
      return deny("plan:read-only", "Planning is read-only; no commands run.");
    }
    if (!command) return ask("bash:empty", "Empty command.");
    return classifyBash(command, ctx);
  }

  // --- web ----------------------------------------------------------------
  if (tool === "WebFetch" || tool === "WebSearch") {
    return ask("web:approval", "Internet access needs owner approval.");
  }

  // --- harmless internals -------------------------------------------------
  if (HARMLESS_TOOLS.has(tool)) {
    return allow("internal:harmless", "Internal bookkeeping tool.");
  }

  // --- everything else ----------------------------------------------------
  return ask("tool:unclassified", `Unrecognized tool "${tool}" — owner approval required.`);
}
