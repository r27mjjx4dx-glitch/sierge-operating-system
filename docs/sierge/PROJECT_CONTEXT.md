# Sierge Project Context

> Authority level 3 (see `CLAUDE.md` §2). This file records the product intent,
> constraints, and system facts that are not derivable from the code itself.
> The owner may edit any section; Sierge (Claude) keeps it current as the
> product evolves. Last updated: 2026-07-22.

## 1. Product intent

Sierge is a management workspace for a non-technical product owner who wants
Claude to build and maintain software on their behalf. The owner describes what
they want in plain language; Sierge keeps the product context, requirements,
decisions, tasks, files, previews, releases, and history organized, while
Claude Code acts as the architect, full-stack developer, debugger, tester, and
release assistant.

**Positioning:** Sierge is *not* a replacement for Claude Code. It is the
management and control layer around Claude Code that makes software creation
understandable and manageable for its owner.

**Core promise:** the owner can say what should happen next, understand the
proposed change, approve it, and receive a working, tested result — without
losing control of the product and without reading the codebase.

## 2. Users and actors

- **Owner** (primary): a founder, operator, creator, or small-business owner
  with a product idea who does not want to manage source code, architecture,
  deployments, or debugging directly. The owner is always the decision-maker.
- **Claude Code** (agent): performs architecture, implementation, debugging,
  testing, and release assistance under Sierge's supervision and the owner's
  approval.
- **Sierge itself** (system): orchestrates the build cycle, enforces safety
  boundaries, records history, and presents everything in plain language.
- v1 is **single-owner, local installation**. No multi-tenant requirement.

## 3. Core use cases

In priority order:

1. **The build cycle** (first vertical slice — must work end to end):
   1. Owner creates or opens a Sierge project.
   2. Owner writes a request such as "Add a customer intake form."
   3. Sierge shows the project context Claude will use.
   4. Claude produces a plain-language plan: assumptions, affected areas,
      acceptance criteria.
   5. Owner approves or edits the plan.
   6. Claude Code implements the change on an isolated work branch.
   7. Sierge runs tests, linting, type checks, and a build where available.
   8. Sierge provides a preview or local run link when available.
   9. Owner sees the result, changed files, validation evidence, limitations,
      and next actions.
2. Maintain owner-editable project context and decisions across sessions.
3. Keep an understandable history of requests, plans, changes, and releases.
4. (Later) releases/deployment assistance, always owner-approved.

## 4. Invariants and business rules

- The owner remains the decision-maker; Claude proposes and implements
  **approved** work only.
- The system must never silently deploy, delete data, change credentials, or
  make irreversible changes.
- Failed builds and incomplete work must be visible — never presented as
  finished. Validation evidence is reported honestly.
- Implementation happens in isolation (work branch); the owner's accepted
  state is never corrupted by in-progress work.
- Project context and decisions are editable by the owner and preserved
  across sessions.
- Only essential clarifying questions are asked; the owner is not interrogated.

## 5. Technical stack and conventions

- **Claude integration:** Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) —
  Claude Code packaged as a library (harness, built-in tools, permission
  modes, sessions). Sierge drives it programmatically; Claude Code is
  installed and authenticated on the owner's machine.
- **Everything else:** proposed in ADR-0002 (`DECISIONS.md`) — pending owner
  approval. Record the accepted stack here once ADR-0002 is accepted.
- Development platform: Windows 11 (owner's machine).

## 6. Environments and validation

- v1 runs entirely on the owner's machine. No cloud deployment of Sierge
  itself.
- Validation commands: _none yet — record here once the scaffold exists._

## 7. Non-functional requirements

- **Understandability first:** every surface the owner sees is plain language;
  no raw jargon, diffs-only views, or unexplained errors.
- **Trust/auditability:** every action Claude takes is recorded and reviewable.
- **Local-first reliability:** state survives restarts; an interrupted build
  cycle is recoverable or clearly marked failed, never lost or half-applied.
- Single-user scale; responsiveness matters more than throughput.

## 8. Out of scope (v1)

- Multi-tenant / hosted SaaS version of Sierge.
- Automatic deployment to production without explicit owner approval.
- Team collaboration, roles, and permissions beyond the single owner.
- Managing projects not created/registered through Sierge.
