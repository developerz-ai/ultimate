# 10 — Carried backlog: features owed by superseded plans

> Part of [`overview.md`](overview.md). Depends on: 09 merged; rows marked ★ wait on an owner decision.
> **Sweeps 10a–10e** — one PR each, ≤ 4 agents, ≤ 100 files, tier order. Carried verbatim-enough from
> `docs/plans/2026/09/22/102-downstream-app-gaps` (slices 01–13) and `docs/plans/2026/09/28/101-audit-bugs-and-gaps`
> (slices 06, 08, 09), both superseded by this plan. Re-verified against `d7b8c7fa`, As of 2026-10.
> Each row is a factory/option over an existing primitive — no ninth kind.

## Sweep 10a — tiers 0–1 seams
| Row | Pkg (tier) | What | Evidence of absence | Test |
|---|---|---|---|---|
| B1 | core (0) | `serializeSetCookie` | not in tree | `core/src/cookie.test.ts` round trip with `readCookie` |
| B2 | schema (0) | `t.json()` | not in tree | `schema` unit |
| B3 | time (1) | `addPlainMonths` (end-of-month clamp), `addMonthsInZone` (keeps local time across DST), `plainDateRange`, memoised holiday set | absent from `time/src/index.ts` | `time/src/months.test.ts` (Jan 31 + 1 → Feb 28/29; DST spring-forward) |
| B4 | storage (1) | S3 object lock: send `x-amz-object-lock-mode`, `retain-until-date`, `legal-hold`, metadata, cache-control (replaces refusal `driver-s3.ts:220-225`); `retentionOf`; local-disk emulation | refusal still at `:220-225` | unit + opt-in `driver-s3.live.test.ts` on `S3_OBJECT_LOCK_BUCKET` |
| B5 | core (0) | `signAwsRequest` (SigV4) — shared by storage s3 + mail SES | not in tree | known-answer vectors from the AWS SigV4 test suite |

## Sweep 10b — tiers 1–3
| Row | Pkg | What | Test |
|---|---|---|---|
| B6 | entity (2) + db (1) | `entity({ appendOnly: true })`: repo refuses update/delete `X_ENTITY_APPEND_ONLY`; `x db gen` emits the trigger; drift `X_APPEND_ONLY_TRIGGER_MISSING` | `entity` unit + `db` `.live` trigger test |
| B7 ★ | http (2) | after O-1: `defineApiRoute` + mount `apps/*/api/**/route.ts` (`cli/src/live-routes.ts:186` skip removed, `cli/src/api-routes.ts`); `X_API_ROUTE_UNDECLARED`; `verifyHmacSignature`, `verifyWebhookSignature` rebased on it | `http` unit + cli e2e |
| B8 | http (2) | `setCookie(name, value, opts)` for loader/handler on B1; migrate auth's literal cookie strings | `http` unit |
| B9 ★ | query (3) | `query({ audit: true })`: `AuditSink`/`AuditRecord` move to core, `action` → `name` (**BREAKING → 12-major-25**); one record per call incl. memo hits; denied/failed; `surface: 'mcp'` | `query` unit + parity with action audit |

## Sweep 10c — tier 4
| Row | Pkg | What | Test |
|---|---|---|---|
| B10 | mcp (4) | request facts → `resolveToken` (`mcp/src/transport-http.ts:85,244`); `onAudit` hook (`mcp/src/audit.ts`); confirm factory `mcpConfirmations` (pending row, approve/reject, `X_MCP_CONFIRMATION_EXPIRED`) | `mcp` unit + `.contract` |
| B11 | mail (4) | SES driver on B5, `retainMime`, `DeliveryEvent` normalisers (SES + Resend, SNS signature check) | `mail` unit + recorded fixtures |
| B12 | ai (4) | `claude-opus-5-5` model row with its thinking rule (`ai/src/models.ts:26-32`; check `disableThinkingUpTo` `:63`); document + image `AiContentBlock` variants (`provider.ts:32-40`); `X_AI_CONTENT_UNSUPPORTED` | `ai` unit + `provider-parity.test.ts` |
| B13 | pwa/cache/render | reserved codes `X_SW_HAND_EDITED`, `X_SW_UNCACHEABLE`, `X_CACHE_UNTAGGED_QUERY` (`wiki/Error-Codes.md:1083-1091`): build each check or keep reserved — owner O-13 | per check |

## Sweep 10d — tier 5
| Row | Pkg | What | Test |
|---|---|---|---|
| B14 | admin (5) | `readonly` admin action runnable by `admin:read`; real scopes for `admin/src/mcp.ts:445` (`scopes: new Set()`); tool names (`admin/src/mcp-tools.ts:199,234`) per O-10a | `admin` unit |
| B15 | cli scaffold | (a) Dockerfile `USER bun` vs helm `runAsUser: 65532` — one uid (`templates/scaffold-container.ts:95-97`, `scaffold-helm.ts:76`); (b) `isDbSpecifier` catches `repo` (`cli/src/app-boundaries.ts:64-68`), dashboard example goes through a query (`templates/scaffold-dashboard-example.ts:38`); (c) delete unused domain `ROLES` (`templates/scaffold-domain-package.ts:26`); (d) `x i18n add` marks copied values (`cli/src/i18n-audit.ts:188-193`); (e) image-publish workflow + configurable runner (`templates/github/ci.yml.ts:64`); (f) `@ultimat3/auth` dependency + dev-actor → real auth path (`templates/scaffold-repo.ts:90-110`, `scaffold-auth.ts:45`); (g) verify `x g resource --feature f` writes into `f/` (`cli/src/generate-kinds.ts:198`) | scaffold-gate (`scripts/scaffold-gate.ts`) + template unit tests |
| B16 | examples/dummy | one idiomatic use each of `transition`, `agentJob`, `hive`, `exportRows`, `purge`, `webhook`, `notifier` + guard test that every `PRIMITIVE_FACTORIES` entry is used in the reference app; `dummy/social-media-clone` one e2e smoke | `scripts/primitive-factories.test.ts` extended |

## Sweep 10e — docs
- `wiki/Known-Gaps.md` rows for every B-row still open after 10a–10d, each with its tracking issue.
- `wiki/PWA-And-Offline.md:270-280` after O-11.

## Done when
- Every B-row merged or explicitly moved to Known-Gaps with an issue; `bun run verify` green after each sweep.
