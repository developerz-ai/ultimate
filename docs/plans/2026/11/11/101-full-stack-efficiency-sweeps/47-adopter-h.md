# 47 — Adopter H

> Part of [`overview.md`](overview.md). **Edited from adopter H's own repository, never from this one**, under its own `CLAUDE.md`; if its checkout is not on `main`, work in a git worktree there. Depends on: the framework release that carries the slices named below. As of 2026-11-11: 30.6.0, `main`, ~160k LOC.

## Findings (read-only audit 2026-11-11)
- Three repositories write per id: `updateWhere` has no `in`.
- Two own lease + heartbeat + stale-sweep sets (agent runs, flow engine).
- Own audit group-commit wrapper, own per-request memo, own bounded pool ("the entity layer takes no signal"), own sorted advisory-lock helper.
- `exercise` not in the floor.
- Open field reports: media generation in the AI gateway, `x token`, job debounce/expiry/priority, per-run bounds that raise a ceiling.

## Steps
1. `x upgrade`.
2. Chain terminals in the three repositories ([`05`](05-entity.md), ~3 files).
3. Drop both lease sets after [`09`](09-jobs.md) (~8 files).
4. Drop the audit wrapper for `postgresAuditSink({ groupCommit: true })` ([`08`](08-action-query.md)); the memo for `memoPerRequest` ([`04`](04-cache-seo.md)), the pool for `mapBounded` ([`02`](02-schema-core.md)); the lock helper for `lockKeys` ([`05`](05-entity.md)).
5. `exercise` in the floor.
6. Adopt `x token` ([`14`](14-cli-commands-upgrade.md)) and job debounce/expiry ([`09`](09-jobs.md)) where the app works around them.

## Tests
- That repository's own gate: `bun run verify` (`x verify`), every step in its floor green.
- Each replaced hand-rolled mechanism: a `statements` fixture or the existing test proves the same behaviour on the framework's.

## Done when
- None of the five wrappers left; `exercise` in the floor; gate green.
