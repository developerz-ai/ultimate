# 10 — Carried backlog: features owed by superseded plans

> Part of [`overview.md`](overview.md). Depends on: 09 merged; rows marked ★ wait on an owner decision.
> **Sweeps 10a–10e** — one PR each, ≤ 4 agents, ≤ 100 files, tier order. Carried verbatim-enough from
> `docs/plans/2026/09/22/102-downstream-app-gaps` (slices 01–13) and `docs/plans/2026/09/28/101-audit-bugs-and-gaps`
> (slices 06, 08, 09), both superseded by this plan. Re-verified against `d7b8c7fa`, As of 2026-10.
> Each row is a factory/option over an existing primitive — no ninth kind.

Coordinator-only in every sub-sweep: `CHANGELOG.md`, `wiki/Error-Codes.md`, `framework.manifest.json`, `bun.lock`, package `index.ts` re-export merges, `status.yml`.

## Sweep 10a — tiers 0–1 seams

| Agent | Rows | Exclusive paths |
|---|---|---|
| A | B1 | `packages/core/src/cookie.ts` + test |
| B | B2 | `packages/schema/src/` (new `json` type) + test |
| C | B3 | `packages/time/src/` new `months.ts` + `holidays.ts` memo + tests |
| D | B4, B5 | `packages/core/src/` new `aws-sigv4.ts`, `packages/storage/src/driver-s3*.ts`, `driver-local*.ts` + tests |

| Row | Pkg (tier) | What | Evidence of absence | Test |
|---|---|---|---|---|
| B1 | core (0) | `serializeSetCookie` | not in tree | `core/src/cookie.test.ts` round trip with `readCookie` |
| B2 | schema (0) | `t.json()` | not in tree | `schema` unit |
| B3 | time (1) | `addPlainMonths` (end-of-month clamp), `addMonthsInZone` (keeps local time across DST), `plainDateRange`, memoised holiday set | absent from `time/src/index.ts` | `time/src/months.test.ts` (Jan 31 + 1 → Feb 28/29; DST spring-forward) |
| B4 | storage (1) | S3 object lock: send `x-amz-object-lock-mode`, `retain-until-date`, `legal-hold`, metadata, cache-control (replaces refusal `driver-s3.ts:220-225`); `retentionOf`; local-disk emulation | refusal still at `:220-225` | unit + opt-in `driver-s3.live.test.ts` on `S3_OBJECT_LOCK_BUCKET` |
| B5 | core (0) | `signAwsRequest` (SigV4) — shared by storage s3 + mail SES | not in tree | known-answer vectors from the AWS SigV4 test suite |

## Sweep 10b — tiers 1–3

| Agent | Rows | Exclusive paths |
|---|---|---|
| A | B6 | `packages/entity/src/` (repo, define), `packages/db/src/{generate,drift}.ts` + tests |
| B | B7 ★ | `packages/http/src/` new `api-route.ts`, `webhook-verify.ts`, `packages/cli/src/{api-routes,live-routes}.ts` + tests |
| C | B8 | `packages/http/src/` new `set-cookie.ts`, `packages/auth/src/` cookie call sites + tests |
| D | B9 ★ | `packages/query/src/` audit, `packages/core/src/` audit types + tests |

| Row | Pkg | What | Test |
|---|---|---|---|
| B6 | entity (2) + db (1) | `entity({ appendOnly: true })`: repo refuses update/delete `X_ENTITY_APPEND_ONLY`; `x db gen` emits the trigger; drift `X_APPEND_ONLY_TRIGGER_MISSING` | `entity` unit + `db` `.live` trigger test |
| B7 ★ | http (2) | after O-1: `defineApiRoute` + mount `apps/*/api/**/route.ts` (`cli/src/live-routes.ts:186` skip removed, `cli/src/api-routes.ts`); `X_API_ROUTE_UNDECLARED`; `verifyHmacSignature`, `verifyWebhookSignature` rebased on it | `http` unit + cli e2e |
| B8 | http (2) | `setCookie(name, value, opts)` for loader/handler on B1; migrate auth's literal cookie strings | `http` unit |
| B9 ★ | query (3) | `query({ audit: true })`: `AuditSink`/`AuditRecord` move to core, `action` → `name` (**BREAKING → 12-major-25**); one record per call incl. memo hits; denied/failed; `surface: 'mcp'` | `query` unit + parity with action audit |

## Sweep 10c — tier 4

| Agent | Rows | Exclusive paths |
|---|---|---|
| A | B10 | `packages/mcp/src/{transport-http,audit}.ts`, new `confirmations.ts` + tests |
| B | B11 | `packages/mail/src/` new `driver-ses.ts`, `delivery-event.ts` + tests |
| C | B12, B19 | `packages/ai/src/{models,provider}.ts`, `openai-*.ts` content blocks + tests; `packages/ui/src/theme/brand-declarations.ts` (B19) |
| D | B13 | per O-13: `packages/pwa/src/`, `packages/cache/src/` check sites |

| Row | Pkg | What | Test |
|---|---|---|---|
| B10 | mcp (4) | request facts → `resolveToken` (`mcp/src/transport-http.ts:85,244`); `onAudit` hook (`mcp/src/audit.ts`); confirm factory `mcpConfirmations` (pending row, approve/reject, `X_MCP_CONFIRMATION_EXPIRED`) | `mcp` unit + `.contract` |
| B11 | mail (4) | SES driver on B5, `retainMime`, `DeliveryEvent` normalisers (SES + Resend, SNS signature check) | `mail` unit + recorded fixtures |
| B12 | ai (4) | `claude-opus-5-5` model row with its thinking rule (`ai/src/models.ts:26-32`; check `disableThinkingUpTo` `:63`); document + image `AiContentBlock` variants (`provider.ts:32-40`); `X_AI_CONTENT_UNSUPPORTED` | `ai` unit + `provider-parity.test.ts` |
| B13 | pwa/cache/render | reserved codes `X_SW_HAND_EDITED`, `X_SW_UNCACHEABLE`, `X_CACHE_UNTAGGED_QUERY` (`wiki/Error-Codes.md:1083-1091`): build each check or keep reserved — owner O-13 | per check |

## Sweep 10d — tier 5

| Agent | Rows | Exclusive paths |
|---|---|---|
| A | B14, B20 | `packages/admin/src/{mcp,mcp-tools}.ts`, `screen-home*.ts` (B20) + tests |
| E | B23 | `packages/ai/src/{models,llm,agent,gateway,echo-provider,errors}.ts`, `packages/ai/README.md` |
| B | B15 (a)–(c), (g) | `packages/cli/src/templates/{scaffold-container,scaffold-helm,scaffold-dashboard-example,scaffold-domain-package}.ts`, `packages/cli/src/{app-boundaries,generate-kinds}.ts` |
| C | B15 (d)–(f), B18, B21 | `packages/cli/src/i18n-audit.ts`, `templates/github/ci.yml.ts`, `templates/{scaffold-repo,scaffold-auth}.ts`; the binary's runtime resolution + `.github/workflows/ci.yml` windows job (B18) |
| D | B16, B17 | `examples/dummy/**` factory uses and the `likedByMe` read (B17), `dummy/social-media-clone/**/e2e`, `scripts/primitive-factories.test.ts` |

| Row | Pkg | What | Test |
|---|---|---|---|
| B14 | admin (5) | `readonly` admin action runnable by `admin:read`; real scopes for `admin/src/mcp.ts:445` (`scopes: new Set()`); tool names (`admin/src/mcp-tools.ts:199,234`) per O-10a | `admin` unit |
| B15 | cli scaffold | (a) Dockerfile `USER bun` vs helm `runAsUser: 65532` — one uid (`templates/scaffold-container.ts:95-97`, `scaffold-helm.ts:76`); (b) `isDbSpecifier` catches `repo` (`cli/src/app-boundaries.ts:64-68`), dashboard example goes through a query (`templates/scaffold-dashboard-example.ts:38`); (c) delete unused domain `ROLES` (`templates/scaffold-domain-package.ts:26`); (d) `x i18n add` marks copied values (`cli/src/i18n-audit.ts:188-193`); (e) image-publish workflow + configurable runner (`templates/github/ci.yml.ts:64`); (f) `@ultimat3/auth` dependency + dev-actor → real auth path (`templates/scaffold-repo.ts:90-110`, `scaffold-auth.ts:45`); (g) verify `x g resource --feature f` writes into `f/` (`cli/src/generate-kinds.ts:198`) | scaffold-gate (`scripts/scaffold-gate.ts`) + template unit tests |
| B16 | examples/dummy | one idiomatic use each of `transition`, `agentJob`, `hive`, `exportRows`, `purge`, `webhook`, `notifier` + guard test that every `PRIMITIVE_FACTORIES` entry is used in the reference app; `dummy/social-media-clone` one e2e smoke | `scripts/primitive-factories.test.ts` extended |
| B17 | examples/dummy (found by sweep 9's e2e) | A like on a post the viewer ALREADY liked paints +1 then drops back: the post row the page reads carries no `likedByMe`, so the optimistic twin (`app/posts/channel-ref.ts:27-36`, `like-mutation.ts`) cannot know the like is a toggle-off. **Fix:** Put `likedByMe` on the post the page reads (per actor), or make the mutator read it from the like row; one-record-many-places e2e on an already-liked post | `one-record-many-places.e2e.test.ts` on `timezones` (already liked by Ada) |
| B18 | cli (Windows, carried from 08 W7/W8) | On `windows-latest` the scaffold smoke is green through `x build --target binary`, but the binary never answers `/healthz`: `error: Cannot find module '@ultimat3/core' from '<app>\\app.config.ts'`. The binary launches an app tree from its cwd and imports `app.config.ts` at runtime; resolving the app's packages from that file fails under Windows' copied `file:` install. **Fix:** Resolve the app tree's imports from its own `node_modules` at runtime (or bundle `app.config.ts` into the binary); then drop `continue-on-error` from the job and make it required in `verify` | the windows job's binary step, then `ci-workflow-shape` pins the job as required |
| B19 | ui (found by 9b's security audit, Low) | `FONT_STACK_PATTERN` (`ui/src/theme/brand-declarations.ts:22`) accepts `\r` through `\s`; a CRLF font stack makes the browser's normalised bytes miss the server's sha256, so the brand is blocked (fails closed). **Fix:** `\s` → a literal space | `brand-preset.test.ts`: a `\r` in a font stack is refused |
| B20 | admin (found by 9b's security audit, Low) | `/admin` home runs one full `count()` per listable resource on every visit (`screen-home.tsx:114`, `screen-home-counts.ts:33`) — any admin user amplifies DB load by reloading. **Fix:** Per-resource opt-in (`count: true`, as the list tabs require, `list-scope.ts:107-115`), or a short per-actor cache | `screen-home.test.ts`: a resource without the opt-in is not counted |
| B21 | cli (from 10c B11) | `runtime-services.ts` calls `selectMailDriver(env)` with no options, so an app on the `x` runtime cannot turn on mail's `retainMime`. **Fix:** a `mail.retainMime` config key read at boot and passed through | runtime-services test: the config key reaches the selected driver |
| B22 | docs (from 10c B11) | the six `SES_*` mail env keys are documented in mail's README only. **Fix:** add them wherever the wiki lists mail's env keys (the page `driver-env.test.ts` cites) | doc-paths and wiki-tables green |
| B23 | ai (owner, 2026-10-06: apps bring their own models and providers) | 24.x half of M12: resolving a model through the built-in `DEFAULT_MODEL`, or pricing one through a built-in catalogue row the app never registered, records a deprecation (`core/src/deprecation.ts`) naming `createGateway({ defaultModel })` / `registerModel`. `X_AI_GATEWAY_MISSING`'s fix is provider-neutral (`ai/src/errors.ts:136`). The README leads with "register your models, pick your provider", with Anthropic and the OpenAI format as peer adapters. Both tracked apps register the models they use | ai unit: each deprecation fires once; the fix line names no vendor; the apps' `llm()`s resolve without a built-in row |
| B24 | jobs, ai (from 10d B16) | `agentJob` has no idiomatic reference-app use: a queued run keeps no output (`x_jobs` has no result column), so a background agent needs an idempotent write tool. **Fix:** a stored, bounded job result, or document the idempotent-tool requirement and give Postly one **Closed** in sweep 13 (#703, #706): `agentJob(agent, { actor })`; Postly's `reviewDraftLater = agentJob(keepDraftReview, { actor })` — the wrapping action makes the idempotent write (`ctx.posts.recordReview`) on the post it was given; the agent holds no write. | `scripts/primitive-factories.test.ts`: `agentJob` leaves the pending list |
| B25 | jobs (from 10d B16) | `webhook` has no reference-app use: it needs an endpoints table with a sealed secret and a delivery ledger the app owns. **Fix:** give Postly that table and one webhook, or ship the table as a framework schema leaf **Closed** in sweep 13 (#703, #706): `webhook` deliveries carry `orgId`; Postly owns its endpoints, deliveries ledger and a `post.published` webhook. | `webhook` leaves the pending list |
| B26 | schema, entity (from 10d B16) | No array item-count bounds (`t.array(...)` has no `min`/`max`; Postly uses `t.refine`), and `transition()` has no row loader, so its policy can't see the row (authorship). **Fix:** `t.array(x, { min, max })` and a `row` loader on `transition()`, the same seam actions have **Closed** in sweep 13 (#701, #703): `t.array(x, { min, max })` and `transition({ row })`; the check-then-act window (#702) is closed in sweep 14: the compare-and-set also pins the columns the policy read. | schema and entity unit |
| B27 | cli (from 10d B16) | An app needing a Postgres executor writes its own (`examples/dummy/packages/db/src/executor.ts`) because `pgExecutorFor` isn't exported. **Fix:** export it from the one place apps import runtime seams, or say why not **Closed** in sweep 13 (#701, #703): `@ultimat3/db`'s `dbExecutor()` is the one executor; Postly's copy is deleted. | cli export test; Postly uses it |
| B28 | examples/dummy (from #684 review) | `summarize` interpolates the post's title and body unfenced, so a body with `## Rules` can pose as instructions; `reviewDraft` already fences its draft as `<post_title>`/`<post_body>` data with closing tags escaped. **Fix:** `summarize@5`, fenced the same way, with a re-recorded baseline | `prompt-artifacts.test.ts` and the summarize eval |
| B29 | manifest (found by 10e) | the manifest does not record an admin action's `readonly`, so a change from `admin:write` to `admin:read` is invisible to `x manifest diff`. **Fix:** the whole contract, since the consumer can't keep fields the producer never sends: `packages/admin/src/describe.ts` emits `readonly` and `matching` (which forces write), `AdminActionFact` (`packages/manifest/src/schema.ts`) declares them, and `actionOf` (`sources-admin.ts`) parses them | manifest unit: flipping `readonly` or `matching` changes the manifest |
| B30 | manifest, admin (from sweep 11 F2) | `gateOf` in `packages/manifest/src/diff-admin.ts` restates admin's `adminPermissionForAction` (`readonly`/`matching`/`destructive` → read/write/destroy), because admin is a tier above manifest and can't be imported. Nothing holds the two equal. **Fix:** move the rule down to manifest (or core) as data, with admin importing it, or a cross-package test pinning both on every combination | a test over the 8 combinations, both sides |

## Sweep 10e — docs

| Agent | Rows | Exclusive paths |
|---|---|---|
| A | docs, B22 | `wiki/Known-Gaps.md`, `wiki/PWA-And-Offline.md`, the wiki page listing mail's env keys (B22) |

- `wiki/Known-Gaps.md` rows for every B-row still open after 10a–10d, each with its tracking issue.
- `wiki/PWA-And-Offline.md:270-280` after O-11.
- From 10d B14/B20/B23: `wiki/Agents.md:423` (the gateway fix names no vendor); `wiki/Admin-Dashboard.md` (`readonly` actions, the admin tool-scope table, `tokenScopes`, the home's `count: true`); `packages/admin/CLAUDE.md` is at its ceiling, so move narrative to `docs/history/` and add the scopes/`count` rules and the `mcp-scopes.ts` row.
- From 10d B15: `docs/ops/README.md:111` and `docs/ops/01-kubernetes.md:238` say the scaffold runs uid/gid 1000 in both the Dockerfile and the chart; `docs/architecture/02-boundaries.md:45` and `wiki/Troubleshooting.md:52` say a route importing a slice's `repo.ts` is `X_BOUNDARY_ROUTE_TO_DB`.

## Done when
- Every B-row merged or explicitly moved to Known-Gaps with an issue; `bun run verify` green after each sweep.
