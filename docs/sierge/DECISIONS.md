# Sierge Decision Records

> Authority level 4 (see `CLAUDE.md` §2). Append-only log of durable
> architecture and product decisions. Newest entries at the bottom.
> Format: ID, date, status, context, decision, consequences.

---

## ADR-0001: Adopt the Sierge Operating System charter

- **Date:** 2026-07-22
- **Status:** Accepted

### Context

The project needed a durable operating contract for how Claude Code (acting as
"Sierge") plans, implements, secures, tests, and communicates changes.

### Decision

The Sierge Operating System charter is persisted as `CLAUDE.md` at the
repository root so it loads automatically every session. `docs/sierge/PROJECT_CONTEXT.md`
holds product intent and constraints; this file holds durable decisions. The
authority hierarchy in `CLAUDE.md` §2 governs conflicts.

### Consequences

- All future work follows the charter's modes, checklists, and definition of done.
- Product requirements must be recorded in `PROJECT_CONTEXT.md` before feature
  work; Sierge does not invent business requirements silently.
- Durable technical choices (stack, data model, auth, hosting) get an ADR here
  before or alongside implementation.

---

## ADR-0002: Sierge v1 architecture and stack

- **Date:** 2026-07-22
- **Status:** **Proposed — awaiting owner approval**

### Context

The product brief (see `PROJECT_CONTEXT.md`) defines Sierge as a local
management and control layer around Claude Code for a single non-technical
owner on Windows 11. The first vertical slice is one complete build cycle:
request → context → plan → approval → isolated implementation → validation →
preview → review.

This decision was produced by a structured design process: the Claude Agent
SDK's integration surface was verified against official documentation, three
independent architectures were designed (simplicity-first, owner-experience-
first, safety-first), and two adversarial judges scored them. The Electron
desktop proposal was rejected by both judges (heaviest build surface; two SDK
misuse flaws). Both judges recommended the same synthesis, recorded here.

Key verified SDK facts this design depends on:

- `query()` returns an async stream of messages; `includePartialMessages`
  gives token-level streaming for live UI.
- `permissionMode: 'plan'` produces a read-only planning phase; clarifying
  questions surface through the `canUseTool` callback (`AskUserQuestion`) and
  are answered via `updated_input`. Plan mode ends when the query completes.
- Permission evaluation order is: hooks → deny rules → ask rules → mode →
  allow rules → `canUseTool`. A `PreToolUse` hook therefore fires before
  everything and cannot be short-circuited.
- Sessions are stored keyed by `cwd`; `resume` works reliably only when the
  resumed query uses the same `cwd` as the original.
- `settingSources: []` prevents any on-disk `.claude` settings from widening
  permissions. `total_cost_usd` is an estimate, not billing truth.
- The SDK bundles the Claude Code binary per platform; Windows is supported.

### Decision

**Form factor — one local process.** A single Node.js (22 LTS, TypeScript)
process bound to `127.0.0.1` hosts both the web UI server and the Agent SDK.
The owner launches it via a Start-menu shortcut / `npx sierge` and uses their
browser. No Electron, no separate services, no auth in v1 (loopback binding is
the boundary; single owner).

**Stack.**

| Layer | Choice |
|---|---|
| Backend | Node 22 + TypeScript, Fastify; SSE for live streams, REST for actions |
| Agent | `@anthropic-ai/claude-agent-sdk`, pinned version, driven in-process |
| Frontend | React 18 + Vite + Tailwind, served as static assets by the same process |
| Processes | `execa` for git/validation/preview subprocesses; `tree-kill` for Windows process trees; `get-port` for previews |
| Persistence | Filesystem-native, no database (see below) |

**Persistence — files, not a database.** Owner-editable artifacts are
markdown (`.sierge/context/*.md`, `decisions.md`, per-request `plan.md`,
`result.md`) — the product invariant "owner-editable, survives sessions"
demands documents, and git versions them for free. Machine state is JSON
(`request.json` state machine) and append-only JSONL (`events.jsonl` audit
log), written atomically (temp file + rename), with every state transition
persisted **before** acting so a crash degrades to a visible
"failed/incomplete", never ambiguity. Approval records are typed JSON events,
not prose. Git branches + worktrees are the change history and isolation
mechanism. Agent sessions use the SDK's default same-host storage.

**Isolation — locked worktree.** Every request gets a git branch
(`sierge/req-<id>`) in a worktree under `%LOCALAPPDATA%\Sierge\worktrees\`
(short paths, outside the repo). The worktree is created **before planning**
so the plan and implementation sessions share one `cwd`, making
`resume: planSessionId` safe under the SDK's cwd-keyed session storage
(verify in week one; fallback: approved plan text becomes the contract for a
fresh implementation session). The owner's accepted state (`main`) is only
ever touched by Sierge itself performing `merge --no-ff` after an explicit
owner approval. Claude never holds merge, push, or deploy capability.

**Permission architecture — defense in depth, deny by default.**

1. `PreToolUse` hook (non-bypassable, fires first): appends every tool attempt
   to the audit log **before** any decision, and hard-denies: `git
   push/merge/rebase/tag`, publish/deploy CLIs, `rm -rf` and paths outside the
   worktree, reads/writes matching secret globs (`.env`, `*.pem`,
   `credentials*`), and **any write to `.sierge/**`** (Claude cannot tamper
   with its own audit trail or evidence files).
2. `canUseTool` router (final gate; no `allowedTools`, no `acceptEdits`, no
   `bypassPermissions`, so nothing short-circuits past it): auto-allow reads
   and path-resolved in-worktree writes and whitelisted Bash (package-manager
   commands, `tsc`, `git add/commit/status/diff` on the task branch);
   escalate to a plain-language owner approval card for dependency installs,
   network-touching commands, and anything unclassified (timeout defaults to
   deny; browser notification when a card is waiting); deny dangerous
   patterns as belt-and-suspenders.
3. `settingSources: []` and an explicitly constructed `options.env` (PATH
   only) so no on-disk config widens permissions and no parent-process
   secrets reach the subprocess.
4. Pinned SDK version + a startup self-test that asserts hook-before-
   `canUseTool` ordering before any task may run.

**Honesty is computed, not narrated.** Sierge — never Claude — runs
validation (detected `package.json` scripts: test/lint/typecheck/build) and
derives status from exit codes; missing checks render "not available", never
green. Validation failures feed back into at most two visible auto-fix rounds
before the request surfaces as failed. The review screen adds machine-derived
caveats (denied tool calls, acceptance criteria without evidence, unavailable
checks) alongside Claude's own summary.

**Owner-grade transparency.** A narration layer stores a `plainSummary`
beside `rawJson` for every tool event (curated verb/path mapping; no LLM in
v1) so the live feed reads "Updating the intake form page", with raw detail
behind a disclosure. At the end of implementation, one cheap resumed query
generates per-file plain-language change descriptions keyed to the plan's
acceptance criteria; the review screen leads with an acceptance-criteria
checklist and evidence badges, not diffs. The context shown to the owner in
step 3 is byte-identical to what the plan session receives.

**Preview.** The worktree's dev/start script is spawned on a free port,
health-polled before the link is shown, and tree-killed on close — and always
stopped **before** merge/worktree removal (Windows file locks). No runnable
script → an honest "preview unavailable" state.

### Alternatives considered

- **Electron desktop app** (owner-experience proposal): best transparency
  vision, but rejected — largest slice-one surface (packaging, IPC, dual
  context stores) and two SDK misuses (cross-`cwd` resume; `settingSources`
  breaking its own context guarantee). Its narration layer and
  acceptance-criteria review surfaces are adopted; the shell is not.
- **htmx/EJS no-build frontend** (simplicity proposal): fastest to first
  slice, but Sierge's entire product value is its UI and the review surfaces
  will grow; React + Vite is conventional, agent-friendly, and the build step
  is trivial. Adopted the proposal's one-process/no-database core instead.
- **SQLite for state**: rejected for v1 — a second store invites drift with
  the owner-editable markdown that the invariants require, and adds a native
  module dependency; JSONL + atomic JSON writes cover single-user scale.
- **Managed Agents (Anthropic-hosted)**: rejected — the brief positions
  Sierge as the layer around the owner's local Claude Code; local worktrees,
  local previews, and local git are core to the product.

### Consequences

- Slice one is buildable as one TypeScript codebase: `src/server` (Fastify,
  orchestrator, policy engine, git/validation/preview managers), `src/web`
  (React), shared types package.
- Known accepted risks (tracked, not hidden): Bash policy regexes are not an
  OS sandbox (OS-level sandboxing is a named post-v1 item); previews are
  best-effort for arbitrary projects; cost display is labeled an estimate;
  Node/web projects only in v1.
- Week-one verification items: same-`cwd` plan→implement resume; Windows
  process-tree kill and worktree cleanup under file locks; SDK
  permission-ordering self-test.
