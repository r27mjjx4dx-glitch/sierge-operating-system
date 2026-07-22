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

---

## ADR-0003: Post-v1 OS-level sandboxing of Sierge-run scripts on Windows

- **Date:** 2026-07-22
- **Status:** **Proposed — post-v1; not scheduled into Slice 2.** No v1 code
  changes. This ADR records the intended durable approach so the residual risk
  named in `FIRST_VERTICAL_SLICE.md` has a concrete plan.

### Context

The Slice 1 safety model contains the **agent's tool calls** with a
deny-by-default policy engine (audit-before-decide, hard blocks on
push/merge/deploy/deletes/credentials/secrets/out-of-worktree/`.sierge`). It
does **not** contain code that Sierge itself executes on the agent's behalf: the
project's own `package.json` scripts, run by Sierge during **validation**
(`test`/`lint`/`typecheck`/`build`) and **preview** (`dev`/`start`). Those
scripts may be agent-authored (or carry a compromised transitive dependency's
lifecycle hook), and they run as ordinary Windows processes — outside the SDK
permission hook. This is the top documented residual risk of v1.

The ADR-0002 review hardening already shrank the blast radius: those scripts run
with a **curated environment** (`buildScriptEnv()` — no owner-shell secrets, no
Anthropic auth keys, `extendEnv: false`) inside a **disposable git worktree**
that never reaches the owner's default branch without an explicit Accept. What
remains unaddressed is a real OS boundary: a script can still open a socket
(egress/exfiltration), read files outside the worktree (secrets, the user
profile), and write outside the worktree (persistence, tampering with the
owner's other work). This decision selects the mechanism to close that gap.

### Threat model

- **Actor:** code Sierge executes but the agent influenced — an agent-authored
  `package.json` script, or a malicious/compromised dependency's `postinstall` /
  build / dev-server hook. Treated as **untrusted**, consistent with the rest of
  the architecture treating the agent as untrusted.
- **Trust anchors that remain:** the Sierge host process, the policy engine, the
  git merge gate, and the owner's approval. The sandbox protects the host and
  the owner *from the scripts*; it need not protect the scripts from anything.
- **Assets to protect:**
  1. **Network** — no outbound connections from a script (blocks exfiltration
     and remote-payload pull-in). Exception: the owner may explicitly allow a
     preview server to bind a **local** port for the owner's own browser
     (loopback in, not egress out).
  2. **Secrets / out-of-worktree reads** — a script can read only the task
     worktree, never the user profile, other repos, `.env`/credential stores, or
     the Sierge data directory.
  3. **Out-of-worktree writes** — a script can write only inside the task
     worktree (plus a designated output area), never the owner's other files,
     autostart locations, or the default branch.
- **Out of scope:** kernel exploits / VM escape (accepted for a local
  single-owner tool); protecting one script from another (each runs disposably);
  the agent's own tool calls (already covered by the policy engine).
- **Constraint that shapes the choice:** the reference owner runs **Windows 11
  Home**, so options that require Pro/Enterprise cannot be the default.

### Options considered (verified against current Microsoft / Node / Docker docs)

| Option | Blocks net / secrets / out-of-tree | Runs on Home? | Per-task disposable | Exit code + output back | Owner setup | Verdict |
|---|---|---|---|---|---|---|
| **Docker — ephemeral Linux container** (`--network none`, one worktree bind-mount, `--cap-drop ALL --read-only`) | Yes / Yes / Yes | Yes (WSL2 backend) | Yes (`--rm`) | Clean | Docker install; licensing threshold for large orgs | **Recommended primary** |
| **Disposable WSL2 distro** (`networkingMode=none` or Hyper-V firewall; `automount=false`, `interop=false`; worktree on ext4) | Yes / Yes / Yes | **Yes** | Scripted `wsl --import` / `--unregister` | Clean (`wsl -- cmd`) | WSL install; per-distro orchestration | **Recommended fallback (Home, no Docker)** |
| **Windows Sandbox** (`.wsb`: `Networking Disable`, read-only mapped worktree, write-only output folder) | Yes / Yes / Yes | **No (Pro+ only)** | Yes (truly disposable) | **No API** — poll a mapped folder | Built-in on Pro | Highest assurance, but **single-instance, Pro-only, no result API** → occasional use only |
| **Native AppContainer** (capability-gated: no `internetClient` → no net; worktree ACL only) | Yes / Yes / Yes | **Yes** | Via `CreateProcess` | Clean | None (but needs a native helper) | Strong, lowest latency, Home-friendly; **needs a native addon/helper .exe + careful SID/ACL/firewall wiring** → high cost |
| **Job Objects / restricted tokens alone** | Partial / partial / no | Yes | — | — | — | **Not a security boundary** — resource control / defense-in-depth only |
| **Node.js Permission Model** (`--permission`) | No (see below) | Yes | — | — | None | **Not viable here** |

Key verified facts driving the ranking:

- **Windows Sandbox is Pro/Enterprise/Education only — it cannot run on Windows
  11 Home** — runs **one instance at a time** (no per-task parallelism), and has
  **no headless / exit-code API** (results return only via a writable mapped
  folder). Disqualified as the default for a Home owner and for throughput,
  though it is the strongest boundary for an occasional maximum-assurance run on
  Pro.
- **The Node permission model is explicitly "not a security boundary."** `npm
  run` spawns `cmd.exe`, which requires `--allow-child-process`; that grant hands
  the child unrestricted filesystem and network access (children don't inherit
  the model), a full escape. Network control (`--allow-net`) exists only on
  Node ≥ 25. Usable at most as defense-in-depth *inside* a real sandbox.
- **Docker Desktop** is free for individuals/small orgs but needs a paid
  subscription above 250 employees **or** $10M revenue; **Docker Engine / Moby
  is not covered by that license**, so a business can run the same containers
  fee-free with more setup.
- **AppContainer** is the only strong *native* boundary that works on Home with
  no VM and no license, but launching an arbitrary `node`/`cmd` into one needs
  the Win32 `SECURITY_CAPABILITIES` /
  `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` sequence — not reachable from
  pure Node/PowerShell, so it needs a native addon or helper `.exe` plus brittle
  per-run ACL/firewall wiring (corroborated by OpenAI's public Codex-on-Windows
  write-up).

### Decision

Introduce a **pluggable "script runner" boundary** with a small interface, and
route the two existing chokepoints — `validation.ts` and `preview.ts` — through
it. Ship the backends in this order:

1. **`process` runner (today's behavior)** — the current curated-env `execa`
   path. Remains the fallback when no sandbox backend is available, and is
   surfaced to the owner as "checks ran **without** OS isolation."
2. **`docker` runner (recommended primary)** — ephemeral Linux container per
   run: `docker run --rm --network none --cap-drop ALL --security-opt
   no-new-privileges --read-only -v <worktree>:/work:rw -w /work <image> <cmd>`
   with a `tmpfs` scratch mount. Prefer **Docker Engine** to sidestep Docker
   Desktop licensing where possible; detect either. For preview, publish only
   the chosen loopback port (`-p 127.0.0.1:<port>:<port>`) as an explicit,
   owner-approved, loopback-only allowance — never general egress.
3. **`wsl` runner (Home fallback, no Docker)** — a Sierge-managed disposable
   distro created with `wsl --import` and destroyed with `wsl --unregister`,
   configured `automount=false` + `interop=false`, worktree on ext4, networking
   `none` for validation (Hyper-V firewall egress rules for the loopback-only
   preview case).
4. **`appcontainer` runner (later, optional)** — a native helper `.exe` for
   owners who want native isolation without Docker/WSL; deferred for its
   engineering cost and brittleness.

**Windows Sandbox is intentionally not adopted as a runner** (Pro-only,
single-instance, no result API); it may later be an opt-in "maximum-assurance,
one-at-a-time" mode for Pro owners.

The active boundary is **selected per install by capability detection**, best
available first (docker → wsl → process), with an explicit owner override, and
the active backend is always shown in the UI so "OS-isolated" vs "not isolated"
is never ambiguous.

### How each asset is protected (target end state)

- **Network:** container `--network none` (or WSL `networkingMode=none`); the
  only permitted network is an explicit, owner-approved, **loopback-only**
  preview port — inbound to the owner's browser, not script-initiated egress.
- **Secrets / out-of-worktree reads:** only the worktree is mounted/visible; no
  host profile, no other repos, no `.env` outside the worktree, no Sierge data
  dir. The curated `buildScriptEnv()` allowlist stays, further reduced to the
  owner's per-project config allowlist (`SLICE_2_PLAN.md` §5) — the sandbox
  receives exactly that set and nothing else.
- **Out-of-worktree writes:** only the worktree bind-mount is writable (plus a
  disposable scratch `tmpfs`); the container/distro is discarded after the run,
  so nothing persists outside the worktree the owner already reviews.

### Migration plan (post-v1, incremental; v1 stays intact)

1. **Extract the interface (no behavior change).** Define `ScriptRunner`
   (`runCheck(cmd, cwd, env, timeout) → {exitCode, output}`; `startServer(...) →
   {url, stop()}`) and make the current `validation.ts` / `preview.ts` logic the
   `process` implementation behind it. Ship first — a pure refactor, covered by
   the existing validation/preview tests, changing nothing observable.
2. **Add the `docker` runner** behind capability detection, defaulting to it when
   Docker is present, else `process`. Tests: net-blocked (a script that fetches
   fails), read-blocked (a read outside `/work` fails), write-blocked (a write
   outside `/work` never appears on the host), result-fidelity (exit
   codes/output match the process runner).
3. **Add the `wsl` runner** for Home owners without Docker; same test matrix.
4. **Surface the active boundary** in the UI and in the review caveats: an
   un-isolated (`process`) run is labeled, extending the honesty guarantee to
   "was this checked under OS isolation?"
5. **(Optional, later) `appcontainer` runner** via a native helper, if native
   isolation without Docker/WSL proves worth the cost.
6. **Documentation:** once a sandbox backend is the default, downgrade residual
   risk #1 in `FIRST_VERTICAL_SLICE.md` from "unsandboxed" to "sandboxed when a
   backend is present; `process` fallback labeled."

### Consequences

- The policy engine and every other v1 safety control are **unchanged**; the
  sandbox is an *additional* layer around the two script chokepoints, not a
  replacement.
- New owner-facing setup appears only if they opt into a backend (install
  Docker/WSL); the `process` fallback keeps Sierge working out of the box,
  honestly labeled as not OS-isolated.
- Preview gains a real tension — some apps need a little network/config to boot —
  handled by the loopback-only, owner-approved allowance plus the per-project
  config allowlist, never general egress.
- Accepted limitation: none of these defend against kernel/hypervisor escape;
  acceptable for a local single-owner tool, and a strictly higher bar than the
  v1 process boundary.

### Sources

Windows Sandbox overview and `.wsb` reference (editions, single-instance,
networking/mapped-folder config); WSL advanced config (`networkingMode`,
`firewall`, automount/interop); AppContainer isolation and implementation
(`SECURITY_CAPABILITIES`); Windows container isolation modes; Node.js Permission
Model docs and the `--allow-net` (v25) addition; Docker Desktop licensing;
Chromium sandbox design (Job Objects/integrity not strict boundaries); OpenAI
"Building a safe, effective sandbox to enable Codex on Windows" (2026). URLs
captured in the Slice-2 research record.
