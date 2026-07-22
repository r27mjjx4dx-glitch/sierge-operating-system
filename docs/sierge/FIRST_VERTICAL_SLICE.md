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
  documented residual risk).
- Rich diff viewer (changed-file list + plain descriptions in v1).
