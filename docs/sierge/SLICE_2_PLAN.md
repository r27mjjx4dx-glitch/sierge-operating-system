# Sierge — Slice 2 Plan: Onboard a Real, Trusted Project

> Status: **Proposed — awaiting owner approval and the target-project decision.**
> Architect-mode plan. No v1 behavior or safety control is changed by this
> document; it defines the *next* slice. Companion to `FIRST_VERTICAL_SLICE.md`
> (Slice 1, accepted) and ADR-0003 (post-v1 OS sandboxing).

## Outcome

The owner can point Sierge at a **real project they care about** — an existing
repository, on its real default branch, with real dependencies and a real dev
server — and run the full Slice 1 cycle (request → plan → approve → isolated
implementation → validation → preview → review → accept) safely, without
Sierge damaging the repository or leaking the owner's secrets.

Slice 1 proved the loop on throwaway Node projects. Slice 2 makes the same loop
trustworthy on a project that matters.

## What "a real, trusted project" changes

| Assumption in Slice 1 | Reality in a real project |
|---|---|
| Fresh repo Sierge created | An existing repo with history, remotes, branches |
| Default branch is `main` | May be `master`, `develop`, `trunk`, … |
| Clean working tree at onboarding | Often has uncommitted local work |
| No meaningful dependencies | Real `node_modules`, lockfiles, install steps |
| Dev server needs nothing to start | Dev/preview often needs config/env to boot |
| Nobody cares about commit authorship | Authorship and history hygiene matter |
| Throwaway — mistakes are free | Mistakes could damage real work |

"Trusted" means the **owner** trusts the project and is present to approve; it
does **not** mean the agent is trusted. All Slice 1 safety controls stay on.

## Readiness assessment (evidence from the current code)

These are gaps to address IN Slice 2. They are recorded here, not fixed now,
because the owner accepted Slice 1 as-is and asked that v1 behavior stay
unchanged until Slice 2 is approved.

1. **Default branch is hard-coded to `main`.** `createTaskWorktree`,
   `changedFiles` (`main...branch`), and `mergeTask` (`git checkout main`) all
   assume `main`. A project on `master`/`develop` would fail to create a
   worktree or merge. *(`src/server/gitManager.ts`.)* → Slice 2 must detect and
   use the repository's actual default branch throughout.
2. **Onboarding an existing repo can sweep the owner's uncommitted work into a
   Sierge commit.** `createProject` runs `git add -A && git commit -m "Add
   Sierge project context"` on the target repo; if the working tree is dirty,
   the owner's unrelated changes are committed by Sierge. *(`src/server/stores/projects.ts`.)*
   → Slice 2 must refuse to onboard a dirty repo (or scope the commit to
   `.sierge/` only), and confirm before writing anything into the owner's repo.
3. **Onboarding overwrites repo-local git identity.** `ensureRepo` sets
   `user.name=Sierge` / `user.email=sierge@localhost` on the target repo,
   changing authorship of the owner's future commits from that repo.
   *(`src/server/gitManager.ts`.)* → Slice 2 must preserve an existing identity
   and attribute only Sierge's own commits (e.g. via per-commit
   author/committer overrides), never mutate the owner's config.
4. **No explicit "open an existing project" flow.** Everything goes through
   `createProject`, which scaffolds and commits. → Slice 2 should distinguish
   "adopt this existing repo" (inspect, confirm, minimal writes) from "create a
   new one," and make the `.sierge/` context commit opt-in and clearly explained.
5. **Preview/validation run with a fully stripped environment.** ADR-0002's
   review hardening made Sierge-run scripts use `buildScriptEnv()` (no
   owner-shell secrets) — correct for safety, but a real app's dev server or
   test suite may need specific configuration (a port, a feature flag, a
   non-secret `DATABASE_URL` for a local db) to run at all. → Slice 2 needs an
   **owner-provided, per-project config allowlist**: named variables the owner
   explicitly supplies for scripts, kept out of the audit log and version
   control, distinct from the owner's ambient shell. This dovetails with
   ADR-0003 (the sandbox receives exactly this allowlist and nothing else).
6. **Repository scale.** Real repos are larger; `findTask` scans all projects'
   task files per request, and diffs/change-lists are unbounded. → Slice 2
   should index tasks per project and paginate/summarize large change sets.

## Proposed Slice 2 scope (to build after approval)

Vertical, safe, and small — mirroring the Slice 1 discipline:

1. **Adopt an existing repository.** A new "Open a project I already have"
   flow: the owner points Sierge at a folder; Sierge inspects it (is it a git
   repo? what is its default branch? is the working tree clean?), shows a plain
   summary, and asks for confirmation before writing anything. Refuse a dirty
   tree with a clear explanation.
2. **Default-branch awareness.** Detect and thread the real default branch
   through worktree creation, diffs, and merge — replacing the `main` literal.
   Preserve the owner's git identity; attribute Sierge commits explicitly.
3. **Per-project script configuration.** Owner-supplied, non-secret named
   variables for validation/preview scripts (edited in the UI, stored outside
   the repo, never in the audit log), so a real dev server can actually start —
   without reintroducing the owner's whole shell environment.
4. **Run one real change end to end** on the owner's chosen project as the
   acceptance test for the slice.

**Explicitly deferred to a later slice / gated on ADR-0003:** OS-level
sandboxing of scripts (ADR-0003); non-Node toolchains; multiple concurrent
tasks; deployment/release; multi-user.

## Safety controls that stay UNCHANGED

Everything in `FIRST_VERTICAL_SLICE.md` → "Safety floor" and "Residual risks"
remains in force verbatim, including:

- deny-by-default policy with audit-before-decide;
- hard-blocked pushes/merges/deploys/deletes/credentials/secrets, out-of-worktree
  and UNC paths, and `.sierge/**` edits;
- owner approval as a state-machine gate; Sierge-only merge into the default
  branch; honest, Sierge-run validation;
- the curated script environment (Slice 2 *adds* an owner-allowlisted set on
  top — it does not restore the owner's ambient environment);
- the startup permission-ordering self-test.

Slice 2 only relaxes friction the **owner** controls (which project, which
config variables), never a safety boundary.

## Risks

- Writing into the owner's real repository is the highest-consequence new
  action; mitigated by dirty-tree refusal, explicit confirmation, `.sierge/`
  scoped commits, and never touching remotes (push stays hard-blocked).
- The per-project config allowlist is a new secret-adjacent surface; mitigated
  by keeping it owner-authored, out of the audit log and version control, and
  passed only to the sandbox/script env — never to the agent's own session.
- Until ADR-0003 lands, scripts still run unsandboxed (the documented residual
  risk); Slice 2 does not change that, and the owner is onboarding a project
  *they* trust.

## Decision needed to start building Slice 2

1. **The target project** — the path to the real repository, and roughly what
   it is (framework; does its dev server need configuration to start?).
2. **Confirmation of the Slice 2 scope above**, or edits to it.

Sierge will not begin Slice 2 implementation until the plan is approved and the
target project is named.
