# Sierge Architecture Blueprint

> Companion to ADR-0002 (`DECISIONS.md`): the concrete module map of the
> implemented system. If this file and the code disagree, the code is wrong
> or this file is stale — fix one. Referenced by the build order for the
> first vertical slice (`FIRST_VERTICAL_SLICE.md`).

## Process model

One local Node.js process (`npm start` / `npm run dev`), bound to
`127.0.0.1:4680` — never internet-facing. It hosts:

- the Fastify HTTP server (REST + SSE + static web UI),
- the Claude Agent SDK (in-process; the SDK spawns its own `claude`
  subprocess per session),
- the child processes Sierge deliberately spawns (git, validation scripts,
  preview dev servers).

The web UI is a React SPA (Vite build in `dist/web`; Vite dev server with
`/api` proxy during development).

## Directory map

```
src/shared/            Contracts between server and UI
  types.ts             Domain types, TaskEvent union, wire events
  api.ts               REST + SSE route contract
src/server/
  index.ts             Entry: dirs, crash recovery, routes, listen, preflight
  config.ts            Paths (%LOCALAPPDATA%\Sierge), ports, limits
  fsStore.ts           Atomic writes (temp+rename), JSONL append/read
  events.ts            Audit hub: persist-then-broadcast task events
  preflight.ts         Git/Node/Claude checks + self-test status
  routes.ts            All REST endpoints + the SSE stream
  orchestrator.ts      The 9-step build cycle; approval gates; fix rounds
  gitManager.ts        Repo init, worktree per task, diff, merge-on-accept
  validation.ts        Sierge-run checks, real exit codes, honest statuses
  preview.ts           Dev-server preview: free port, health poll, tree-kill
  policy/
    rules.ts           PURE decide(): hard-deny / auto-allow / ask
    engine.ts          PreToolUse hook (audit-before-decide, hard denies),
                       canUseTool router, ApprovalBroker (timeout -> deny)
    selftest.ts        Live SDK ordering self-test, cached per SDK version
  agent/
    adapter.ts         THE single Agent SDK adapter (query() wrapper)
    env.ts             Explicit subprocess env (no parent secrets)
    prompts.ts         Plan / implement / fix / summarize templates
    planParse.ts       Best-effort plan section parsing (raw md is truth)
    narration.ts       Tool call -> plain-language feed line
  stores/
    projects.ts        Registry, context docs (.sierge/context), decisions
    tasks.ts           Task state machine (persist-before-act), recovery
src/web/               React SPA (screens per FIRST_VERTICAL_SLICE.md)
tests/                 Vitest unit tests (policy rules, plan parsing)
```

## Data locations

| What | Where | Why |
|---|---|---|
| Project registry | `%LOCALAPPDATA%\Sierge\registry.json` | Machine state, outside any repo |
| Task state + audit | `%LOCALAPPDATA%\Sierge\projects\<pid>\tasks\<tid>\{task.json,events.jsonl,logs\}` | Agent (cwd = worktree) can never reach it; never appears in product diffs |
| Worktrees | `%LOCALAPPDATA%\Sierge\worktrees\<pid>\<tid>` | Short Windows paths, outside the repo |
| Owner context docs | `<repo>\.sierge\context\*.md` | Owner-editable, git-versioned, travels with the product |
| Self-test cache | `%LOCALAPPDATA%\Sierge\selftest.json` | Re-run per SDK version |

## The permission chain (enforced order)

```
tool attempt
  └─ PreToolUse hook (cannot be bypassed; asserted by self-test)
       1. append tool_attempt to events.jsonl  ← AUDIT BEFORE DECIDING
       2. rules.decide() == deny  → hard deny (push/merge/deploy/deletes/
          credentials/secrets/out-of-worktree/.sierge/**)
       3. rules.decide() == ask   → force 'ask' so no mode can auto-allow
       4. otherwise defer
  └─ canUseTool (final gate; no allow-rules / acceptEdits / bypass exist)
       allow → log policy_decision, proceed
       deny  → log, deny
       ask   → blocking owner card (SSE + notification), 5-min timeout → DENY
       AskUserQuestion → owner question card → answers via updated_input
```

Session options everywhere: `cwd = worktree`, `settingSources: []`,
explicit `env` (see `agent/env.ts`), `includePartialMessages: true`.
Plan phase: `permissionMode: 'plan'` + read-only tool set. Implementation:
`permissionMode: 'default'` + full Claude Code preset, gated as above.

## Session continuity

The worktree is created at task creation, BEFORE planning, so the plan and
implementation sessions share one cwd; implementation resumes the plan
session (`resume: planSessionId`), fix rounds and the review summary resume
the implementation session. Session IDs are persisted in `task.json` after
every phase for crash recovery.

## Honesty mechanisms (computed, not narrated)

- `validation.ts` runs the project's own `test/lint/typecheck/build`
  scripts and records real exit codes; missing script = `unavailable`,
  never green. At most 2 visible auto-fix rounds, then honest failure.
- Crash recovery (`stores/tasks.ts`): tasks found mid-flight at boot are
  marked `failed` with the work preserved on the branch.
- Review caveats are derived from the audit log (denied actions), the
  validation report (failing/unavailable checks), and the summary
  (unmet/unverified criteria).
- Cost figures are labeled estimates (`total_cost_usd` is not billing truth).
