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
| M9 | B9 landed behind compat fields (24.x): `AuditRecord.name` / `.primitive` are OPTIONAL and `action` is a deprecated alias, read through `normalizeAuditRecord` (`name ?? action`, `primitive ?? 'action'`). In 25.0.0 `name` and `primitive` become REQUIRED and `action` goes; `normalizeAuditRecord` becomes the identity, then goes. The `x_audit.action` column stays (it holds `name`) | `core/src/audit.ts` (type + helper), `action/src/audit-postgres.ts`, `audit-memory.ts`, `audit-gate.ts`, `query/src/audit-gate.ts`, `action/src/invoke.ts` | type pin: a record without `name`/`primitive` fails typecheck; no `action` field in `AUDIT_RECORD_FIELDS` |
| M10 | `http.drainTimeoutMs` — a second knob for the drain budget `drain.deadlineMs` owns since 8c (axiom 1); on the web role it still wins, applied after `lifecycleForRole` | `packages/http/src/config.ts`, `http/src/server.ts` drain read, `cli/src/serve-boot.ts` | config test: one drain key; the web role's budget is `drain.deadlineMs` |
| M11 | `theme.tokens` in app config — read by nothing in the framework since 9b's theme seam (`export const brand` in `apps/web/shared/theme.ts`); a second, dead theming path (axiom 1) | `packages/core/src/config.ts:49` and its defaults/validation | config test: no `theme.tokens` key |
| M12 | **Apps bring their own models and providers (owner, 2026-10-06: "we shouldn't tie to Claude" / "they come with models and providers").** The framework ships mechanism: the provider contract, the two wire-format adapters (Anthropic Messages, OpenAI chat-completions, i.e. any compatible server), the gateway, budgets, `registerModel`. It ships no vendor choice and no vendor data. Today it ships both: `DEFAULT_MODEL = 'claude-opus-5'` (the fallback in `llm()`, `agent()`, the gateway and `EchoProvider`, so an undeclared model silently routes to Anthropic) and a priced catalogue of 6 Claude and 3 GPT rows, which goes stale (this sweep found Sonnet 5's price and two cache rates wrong). Axiom 8, the same class as `defaultTimeZone` (O-6). **Delete both** (`DEFAULT_MODEL`, `ANTHROPIC_MODEL_IDS`, `OPENAI_MODEL_IDS`, the built-in rows, the refusal ladder's built-in rungs). A model resolves from the declaration, then its prompt, then `createGateway({ defaultModel })`; none is a coded refusal naming all three. A model the app has not `registerModel`-ed is `X_AI_MODEL_UNKNOWN` (exists). `x new --ai` (or the scaffold's AI example) writes the app's own `models.ts` with one registration and its source URL, so the data lives and is dated in the app's repo. The 24.x half is B23 (sweep 10d) | `packages/ai/src/{models,openai-models,llm,agent,gateway,echo-provider,errors}.ts`, `ai/README.md`, `core/src/config.ts:192` comment, the scaffold AI template, `examples/dummy` prompts (register what they name) | ai test: no `claude-`/`gpt-` id is reachable unless the app registered it; an `llm()` with no resolvable model is refused, naming the three places; both tracked apps register the models they use; the deprecation from B23 fires in 24.x |
| M13 | core has no general "deprecated use" recorder: `recordDeprecatedCall` counts only deprecated action/query declarations, so ai's B23 notices built their own (`ai/src/deprecations.ts`, logger + `ai_deprecated_fallbacks_total`). One way: `recordDeprecatedUse({ owner, subject, fix, removedIn })` in `core/src/deprecation.ts` (warn once per owner+subject, one `deprecated_uses_total` metric); ai calls it, and its own module goes | `packages/core/src/deprecation.ts`, `packages/ai/src/deprecations.ts` | core test: once per (owner, subject); ai's notices are core records |

Pre-PR: `bug-hunter` + `architecture-reviewer` read-only over the diff (high-stakes rule).

## Sweep 12b — release 25.0.0
Follow `PUBLISHING.md` and `.claude/commands/feature.md` § release; never quote a version — run the commands:
1. `bun run scripts/release.ts --bump major` on a clean `main` (writes manifest, `bun.lock` facts, footer stamp).
2. `bun run scripts/release.ts --check 25.0.0`; PR; merge.
3. `git tag -a v25.0.0` (annotated); push; `gh release create v25.0.0` (the Release triggers `release.yml`). Watch for a bot-made lightweight tag/Release first — delete if unpublished.
4. `bun run scripts/registry-audit.ts --json` → every publishable package on npm at 25.0.0, every one attested. Report the line verbatim.
5. **Scaffold against what npm serves** (found by 10e: CI's scaffold smoke builds against workspace links, so a scaffold that imports an export the registry lacks passes CI and fails `docker build` for a user). In the scratchpad, with no workspace on the path: `bunx create-ultimate@25.0.0 npmapp`, then `bun install`, `bun run check`, and `docker build -f docker/Dockerfile .`. All green, or the release is not done. Then make this permanent: a post-publish job in `release.yml` (or `registry-audit.yml`) that runs the same steps against the just-published version.

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
