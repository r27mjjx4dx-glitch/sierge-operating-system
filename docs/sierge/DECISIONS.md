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
