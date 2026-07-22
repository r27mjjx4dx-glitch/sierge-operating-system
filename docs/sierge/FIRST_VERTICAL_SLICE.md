# Sierge — First Vertical Slice

> Scope contract for slice one, per the product brief in
> `PROJECT_CONTEXT.md` and the approved architecture in ADR-0002.
> Everything in "In scope" must work end to end; everything in "Deferred"
> is genuinely absent, not stubbed.

## The cycle (must work end to end)

1. **Create/open a project** — new git repo under `~/SiergeProjects/<name>`
   (or an owner-chosen folder), scaffolded with owner-editable notes at
   `.sierge/context/`.
2. **Owner writes a request** in plain language.
3. **Sierge shows the exact context Claude will use** ("What Claude will
   know about your project") — byte-identical to the planning prompt bundle.
4. **Claude plans** (read-only plan mode) — the plan streams live; essential
   clarifying questions surface as owner question cards; the result follows
   a fixed plain-language template (Outcome / Assumptions / Affected areas /
   Acceptance criteria / Steps).
5. **Owner approves or edits the plan.** Approval is a state-machine gate;
   nothing reaches implementation without it. A decision entry is recorded.
6. **Claude implements on an isolated branch+worktree** with the
   deny-by-default policy engine, a live narrated activity feed, and
   blocking approval cards for anything unusual (timeout = no).
7. **Sierge runs validation itself** — the project's `test`, `lint`,
   `typecheck`, `build` scripts, real exit codes; up to 2 visible auto-fix
   rounds; failures are never hidden.
8. **Preview** — Sierge starts the project's `dev`/`start` script on a free
   local port, health-checks it, and shows the link; an honest
   "preview unavailable" state otherwise.
9. **Review screen** — machine-derived caveats first, acceptance-criteria
   checklist, plain-language changed-file descriptions, validation evidence
   with logs, preview controls, estimated cost, and the decision bar:
   **Accept** (Sierge merges `--no-ff` into main), **Request changes**
   (loops back with feedback), **Discard** (worktree and branch removed).

## Safety floor (non-negotiable, all implemented in slice one)

- Loopback-only server; no internet-facing surface.
- Isolated worktree per task; owner's `main` touched only by Sierge's
  merge after explicit acceptance.
- Deny-by-default policy; every attempt audited BEFORE deciding.
- Hard-blocked: push/merge/rebase/tag, publish/deploy CLIs, recursive
  deletes, credential/secret files, paths outside the worktree, any write
  to `.sierge/**`.
- Startup self-test asserting hook-before-canUseTool ordering gates the
  first task; failure blocks all tasks with an honest message.
- Crash recovery marks interrupted tasks failed — never silently done.

## In scope (v1 targets)

- Node/web projects (validation + preview via `package.json` scripts).
- One project active at a time per agent run; one task in flight per
  project (enforced).
- Single owner, local machine, Windows 11 first.

## Deferred (not stubbed)

- Deployment/release assistance of any kind.
- Non-Node toolchains; cloud previews/tunnels; MCP/custom tools.
- Multi-user, auth, remote access; concurrent tasks per project.
- Cost budgets/caps (estimate display only); SessionStore adapters;
  OS-level sandboxing (worktree + policy is the v1 boundary — known,
  documented residual risk; see below).
- Rich diff viewer (changed-file list + plain descriptions in v1).

## Residual risks (known, documented, accepted for v1)

These are the boundaries of the v1 safety model. They are not defects; they
are the explicitly-deferred edges, recorded so no one mistakes the policy
engine for an OS sandbox.

1. **The policy engine governs the agent's tool calls, not arbitrary code
   execution.** Sierge runs the project's own `package.json` scripts
   (test / lint / typecheck / build for validation; dev / start for preview)
   inside the worktree — and those scripts may be agent-authored. That code
   runs *without* passing through the `PreToolUse` hook / `canUseTool` policy,
   so a script (or a compromised npm dependency's lifecycle hook) can execute
   logic the policy would otherwise block (network egress, out-of-worktree
   writes, `git push`). Two things bound this in v1: the scripts now run with a
   **curated environment** (`buildScriptEnv`, no owner-shell secrets, no
   Anthropic auth keys — so a hostile script can't read credentials), and the
   worktree/branch is disposable and never reaches the owner's `main` without
   an explicit Accept. **The real fix — OS-level sandboxing of all
   agent-influenced execution — is the primary post-v1 safety item.** Until
   then, treat "the agent can run arbitrary code via a project script" as true,
   and the agent as the (partially trusted) same-Claude actor the architecture
   assumes.
2. **Shell-command policy is pattern-based, not a parser.** The classifier
   hard-blocks pushes/merges/deploys/deletes/credential-and-secret access,
   out-of-worktree and UNC paths, `.sierge` edits, and now also git
   global-option forms (`git -C . push`), common obfuscation (empty-quote /
   caret splitting, encoded PowerShell, `iex`), and quoted/chained redirects.
   A sufficiently novel obfuscation could still degrade a *hard-block* to an
   owner **ask** (never to a silent allow) — and `-EncodedCommand`-style
   opacity is itself hard-blocked because it defeats human review. This is
   defense-in-depth; OS sandboxing (item 1) is the durable boundary.
3. **Single-owner, local, loopback only.** Concurrency guards protect against a
   single owner's duplicate submissions (two tabs, a retry); they are not a
   multi-user authorization model, which is out of scope for v1.
