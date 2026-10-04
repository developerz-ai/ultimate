# 10 — 25.0.0: breaking deletions, release, readiness gate

> Part of [`overview.md`](overview.md). Depends on: 01–11 merged; owner rows answered (or their work
> dropped from this sweep). Tier: 0–5. **Sweeps 12a (deletions) → 12b (release).**

## Rule
One major batches every break (one `CHANGELOG.md` `## 25.0.0` section + `wiki/Upgrading.md` rows).
A deletion that is not breaking does not wait here — it belongs in [`07-cleanup.md`](07-cleanup.md).

## Sweep 12a — deletions (≤ 4 agents, ≤ 100 files; split by tier band if over)

| # | Delete / collapse | Where | Guard keeping it gone |
|---|---|---|---|
| M1 | action/query tool projection twins (O-tool): `toMcpTool`, `toMcpTools`, `McpToolDescriptor` (+ its dead `action` field `:27`); `toQueryTool`, `toQueryTools`, `QueryToolDescriptor`; `.tool()` returns mcp's projection | `packages/action/src/mcp-tool.ts`, `packages/query/src/mcp-tool.ts`, `action/src/facade.ts:36` | parity test: `.tool()` deep-equals the `tools/list` entry |
| M2 | `assertEnvExample` + export | `packages/core/src/env-example.ts:124`, `core/src/index.ts:199` | declaration-readers-style rule: a core export throwing a registered code has a non-test caller |
| M3 | aliases: `nearest` (`cli/src/parse.ts:17`, `cli/src/index.ts:126`), `toolFromQuery` (`mcp/src/from-action.ts:189`), manifest `contentHash` (`manifest/src/build.ts:114` → `fingerprint`), three `isExposed` wrappers (`action/src/mcp-tool.ts:83`, `query/src/mcp-tool.ts:90`, `mcp/src/from-action.ts:105`) | — | `declaration-readers` + unused-export check |
| M4 | `McpExposure.name` (never settable) + `primitive.mcp?.name ??` branch | `mcp/src/from-action.ts:52,114`, `mcp/src/projectable.ts:152` | `declaration-readers` (field read but never written → finding) — extend the guard for this shape |
| M5 | action/query `deprecation` re-exports (moved to core in 07 T2) | `packages/{action,query}/src/index.ts` | `HELPER_HOMES` |
| M6 | memory/postgres factory names → `memoryX` / `postgresX` (delete `create*`, `pg*` spellings: `createMemoryDriver`, `createMemoryLeaseStore`, `createPgDriver`, `createPgInboxStore`, `pgSchedulerState`, `createPostgresClient`) | jobs, mail, notify, db indexes | regex rule over every `src/index.ts` export |
| M7 | unread `SQL_*` index exports (~22 in jobs `:129-175`; action `SQL_IDEMPOTENCY_*`, `SQL_AUDIT_INSERT`; notify `SQL_NOTIFY_CLAIM`, `SQL_NOTIFY_INBOX_PAGE`; admin `SQL_ADMIN_AUDIT_INSERT`) — keep those `sql-literal-copies` needs | package indexes | unused-export check for `SQL_*` |
| M8 | owner "delete" answers: O-12 `Page`, O-6 config keys, O-loc locales keys, O-5 NATS stub, O-4/O-7/O-14/O-18/O-20 per answer | per row in [`00-owner-decisions.md`](00-owner-decisions.md) | per row |
| M9 | B9 `AuditRecord.action` → `name` (if 10 B9 landed behind a compat field) | `action/src/audit.ts:38` → core | — |

Pre-PR: `bug-hunter` + `architecture-reviewer` read-only over the diff (high-stakes rule).

## Sweep 12b — release 25.0.0
Follow `PUBLISHING.md` and `.claude/commands/feature.md` § release; never quote a version — run the commands:
1. `bun run scripts/release.ts --bump major` on a clean `main` (writes manifest, `bun.lock` facts, footer stamp).
2. `bun run scripts/release.ts --check 25.0.0`; PR; merge.
3. `git tag -a v25.0.0` (annotated); push; `gh release create v25.0.0` (the Release triggers `release.yml`). Watch for a bot-made lightweight tag/Release first — delete if unpublished.
4. `bun run scripts/registry-audit.ts --json` → every publishable package on npm at 25.0.0, every one attested. Report the line verbatim.

## Readiness gate — "ready for a large customer" (all must hold)
| Check | Command / evidence |
|---|---|
| gate | `bun run verify` green, all 20 steps, live services up |
| both tracked apps | `bun run scripts/reference-app-gate.ts` green, `expectedRed` `{}` |
| zero open `bug` issues | `gh issue list --label bug --state open` empty, or each remaining one has a Known-Gaps row and is not security/data-integrity |
| security/concurrency rows | every row of 01 and 02 merged |
| windows | the required `windows-latest` CI job green on the release commit ([`08-windows.md`](08-windows.md)) |
| release provenance | `bun run scripts/registry-audit.ts --json` → **every** publishable package on npm at 25.0.0, every one attested (spot-check: `npm view @ultimat3/core@25.0.0 dist.attestations _npmUser`) |
| no stale trackers | every `docs/plans/**/status.yml` `complete` or `superseded` (07 T10 guard) |

## Done when
- 25.0.0 published and attested; readiness table all green; this plan's `status.yml` → `complete`.
