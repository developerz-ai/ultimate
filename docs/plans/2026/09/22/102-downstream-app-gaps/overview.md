# Downstream app gaps

## Goal
Close the framework gaps a real downstream app hit on its first day, scaffolded 2026-09-22 with
`create-ultimate` 20.2.1. The ranking follows how hard each gap blocked the app. Every gap is
checked against this branch. Two were false as asked and six were only partly true; *Risks* lists
them with the `file:line` that disproves each.

## Context
- The tree is at 20.2.1. 21.0.0 is in progress on this branch: plan 101 landed as `71f7c6b0`, and
  `CHANGELOG.md:9-15` holds `[Unreleased]`. Every row marked **21.0.0** below writes a `BREAKING —`
  entry and edits `wiki/Upgrading.md` in the same PR (101's rule).
- Bun only, Postgres with no ORM. Tiers come from `scripts/lib/tiers.ts:15-22`:

| Tier | Packages |
|---|---|
| 0 | `core`, `schema` |
| 1 | `time`, `db`, `storage` |
| 2 | `http`, `entity`, `auth`, `policy` |
| 3 | `action`, `query`, `jobs` |
| 4 | `mcp`, `ai`, `mail`, `render` |
| 5 | `admin`, `cli` |

- None of this adds a ninth primitive. Each fix lands on an existing one:

| Fix | Primitive |
|---|---|
| raw inbound handler | `route` on the `api/` surface. The tree already reserves `api/**/route.ts` (`packages/render/src/registry.ts:33`, `CLAUDE.md:393`) and never mounts it |
| human-confirmed MCP call | an `action` factory in `mcp` |
| append-only table | an `entity` option |
| audited read | a `query` option |
| months, closures | plain `time` helpers |
| SES, raw MIME, delivery events | a mail driver, plus a `route` for the events |

- Reference patterns:
  - blank-reason refusal: `packages/query/src/read.ts:216-226`.
  - one-list mount: `packages/cli/src/api-routes.ts:14-16`.
  - opt-in audit: `packages/action/src/audit.ts:38-107`.
  - existing signature check: `packages/http/src/webhook-verify.ts:117-175`.
  - model rows: `packages/ai/src/models.ts:285-321`.

## Rank
Severity: **blocks-app** (no correct path in the framework), **workaround-exists** (the app ships
around it), **papercut** (wrong default or silent drift). Semver is per the house rule; "21.0.0"
means it removes or renames a public surface and must ride the in-progress major.

| # | Gap (verified) | Severity | Downstream use case | Slice | Semver |
|---|---|---|---|---|---|
| 1 | `api/**/route.ts` method exports are imported and **never mounted**. The http README's webhook example returns 404 (`http/README.md:284-310`, `cli/src/app-load.ts:166-170`, `serve.ts:386-387`). An action cannot read headers or raw bytes (`wiki/Actions.md:96`) | blocks-app | a payment gateway that signs a header over the raw body; an email provider's delivery notifications | 01, 05, 11 | minor |
| 2 | `s3Driver.put` sends only `type` (`storage/src/driver-s3.ts:256`). It refuses metadata (`:192-197`) and has no retention, legal-hold or checksum header. `Bun.S3Client` exposes none of them | blocks-app (checksum unverified) | tamper-evident evidence blobs under S3 Object Lock | 01, 03 | minor |
| 3 | One app MCP mount: the first `apps/*/mcp.ts`, at `config.ai.mcp.path` (`cli/src/app-mcp.ts:19,73,104-127`). `defineAppMcp({ path })` is **ignored** by the CLI (`mcp/src/app-tools.ts:79-80` vs `app-mcp.ts:120`). `include: 'exposed'` has no surface filter (`app-tools.ts:146-147`) | blocks-app | a customer `/mcp` plus a staff `/admin/mcp` | 07, 11 | **21.0.0** (`ai.mcp.path` removed) |
| 4 | No two-step or human-confirm for mutating MCP tools (only `destructive`, `from-action.ts:96`) | workaround-exists | "agent may draft a send; a human approves it" | 07 | minor |
| 5 | `resolveToken(token)` never sees the request (`mcp/src/transport-http.ts:62,136`). Denials are log lines only, with no app hook (`mcp/src/audit.ts:118-132`) | workaround-exists | IP allowlist on the staff surface; denials as DB rows | 07 | minor |
| 6 | `adminMcp()` names tools `admin.action.<name>` (`admin/src/mcp-tools.ts:155,190`), resolves to empty scopes (`admin/src/mcp.ts:363`), and gates every admin action on `admin:write` (`action-gate.ts:37`) | workaround-exists | reusing the admin catalog over MCP | 10 | **21.0.0** (tool names change) |
| 7 | A query has no audit (`wiki/Queries-And-Live-Queries.md:3`). The `audit: true` sink is action-only (`action/src/action.ts:119,352`) | workaround-exists | audit every staff read of personal data | 01, 06 | **21.0.0** (`AuditRecord.action` → `name`) |
| 8 | No append-only table: the entity has no trigger or grant concept (`entity/src/entity.ts:65-93`), and a hand migration needs a snapshot sidecar (`wiki/Migrations-And-Backfills.md:50`) | workaround-exists | audit, evidence and ledger tables | 04 | minor |
| 9 | Mail ships memory, log, SMTP and Resend drivers only (`mail/README.md:43-50`). No SES driver, no access to the exact MIME bytes sent, no delivery-event shape | workaround-exists | keep the exact `.eml` as evidence; ingest bounces | 01, 08 | minor |
| 10 | `claude-opus-5-5` is not registered (`ai/src/models.ts:26-30`), and its "thinking can't be disabled" rule is not expressible (`models.ts:57-63`). `AiContentBlock` is text or tool only (`ai/src/provider.ts:32-45`) | workaround-exists | extracting data from uploaded PDFs and scans | 09 | minor |
| 11 | No cookie setter for a loader or handler. `ctx.headers` merges with `.set` (`http/src/stages.ts:444`), so a second `Set-Cookie` overwrites the first | workaround-exists | a referral cookie set from a landing route | 01, 05 | minor + patch |
| 12 | No month arithmetic (`time/src/index.ts:104-148`). Holidays are a flat date list (`time/src/business.ts:19-26`) | workaround-exists | monthly renewals with end-of-month clamp; multi-week recess closures | 02 | minor |
| 13 | Two default-locale sources. `AppConfig.defaultLocale` and `locales` are read only by their own validation (`core/src/config.ts:333`), while the runtime reads `defineCatalogs({ default })` (`cli/src/app-load.ts:146`). `x i18n add` copies source values unmarked (`cli/src/i18n-audit.ts:188-190`) | papercut | a non-`en` default locale | 01, 12 | **21.0.0** (config keys removed) |
| 14 | The scaffold Dockerfile runs `USER bun` and chowns `/app/.x` to it (`templates/scaffold-container.ts:66-68`). Its Helm values run as `65532` (`templates/scaffold-helm.ts:44-47`) | papercut (deploy risk) | first deploy | 12 | patch |
| 15 | A route importing `repo` passes the gate. `isDbSpecifier` only knows `db` (`cli/src/app-boundaries.ts:55-59`), and the scaffold's own dashboard does it (`templates/scaffold-dashboard-example.ts:39`) | papercut | the "Data" row in the scaffold's AGENTS.md | 12 | patch |
| 16 | Three role lists: `roles.ts` (member, admin), `DEV_ROLES` (`templates/scaffold-auth.ts:43`), and an unused domain `ROLES` (owner, member, viewer) (`templates/scaffold-domain-package.ts:26`) | papercut | a real role matrix | 12 | patch |
| 17 | `x new a.b` writes `a-b/`, and `--force` is checked against the slug (`cli/src/cmd-new.ts:204-218`) | papercut | a dotted domain as the repo name | 12 | patch |
| 18 | `x g resource --feature` is ignored (`templates/resource.ts:173-175`). The `admin:page` default dir `apps/admin/src/pages` (`templates/admin-page.ts:15`) is not where the scaffold writes admin (`templates/scaffold-app.ts:324`) | papercut | generating into a named slice | 12 | patch |
| 19 | Generated CI is `runs-on: ubuntu-latest` (`templates/github/ci.yml.ts:64`), with no image-publish workflow. The `sha-<7>` contract is known (`.github/workflows/deploy-social-demo.yml:7,75`) | papercut | image-updater deploys | 12 | minor |
| 20 | `x g guard` emits the NOT-NULL example under the new guard's code (`templates/guard.ts:28-37`) | papercut | writing a first guard | 12 | patch |
| 21 | No path from dev actor to real auth: `@ultimat3/auth` is not a scaffold dep (`templates/scaffold-repo.ts:80-99`), and `DEFAULT_DEV_ROLE = 'admin'` (`scaffold-auth.ts:48`) | workaround-exists | sign-up and sign-in on day one | 12 | minor |

## Tiers touched
| Package | Tier | Why it must change |
|---|---|---|
| `core` | 0 | `serializeSetCookie`; `AuditSink`/`AuditRecord` move down so query can reach them; SigV4 signer shared by storage and mail; `AppConfig.locales`/`defaultLocale` removed (slice 01) and `ai.mcp.path` removed (slice 11, atomically with the mount) |
| `schema` | 0 | `t.json()`, a JSON-value schema for opaque payload fields |
| `time` | 1 | `addPlainMonths`, `addMonthsInZone`, `plainDateRange` |
| `storage` | 1 | signed PUT with checksum, retention and legal hold; `retentionOf` |
| `db` | 1 | `appendOnly` DDL (trigger) in the generator and drift |
| `entity` | 2 | `appendOnly` option; repos refuse update and delete |
| `http` | 2 | `defineApiRoute`, `bodyBytes()`, `verifyHmacSignature`, `setCookie`, the `Set-Cookie` merge fix |
| `action`, `query` | 3 | audit moves to core; `query({ audit: true })` |
| `mcp` | 4 | surfaces, request-aware `resolveToken`, `onAudit`, confirmation factory |
| `mail` | 4 | SES driver, retained MIME, `DeliveryEvent` normalisers |
| `ai` | 4 | `claude-opus-5-5` row, `disableThinking: 'never'`, document and image blocks |
| `admin` | 5 | tool names, read-only actions, scopes |
| `cli` | 5 | mount api route files and N MCP surfaces; scaffold and generator fixes |

Land the lowest tier first. Every new import goes down: `mail → core` and `storage → core` for
SigV4, `query → core` for audit. Nothing is added to `SIDEWAYS_ALLOW`.

## Plan files (execute in order)
1. [`01-core-schema-seams.md`](01-core-schema-seams.md) — tier 0: cookie serializer, audit types, SigV4, `t.json()`, one default locale.
2. [`02-time-months.md`](02-time-months.md) — tier 1: month math with clamp, date ranges for closures.
3. [`03-storage-object-lock.md`](03-storage-object-lock.md) — tier 1: checksum, retention and legal hold on S3 PUT.
4. [`04-entity-append-only.md`](04-entity-append-only.md) — tiers 1–2: `appendOnly` generates a trigger, is drift-checked, and is refused in repos.
5. [`05-http-api-routes-cookies.md`](05-http-api-routes-cookies.md) — tier 2: `defineApiRoute`, raw bytes, HMAC verify, `setCookie`.
6. [`06-query-audit.md`](06-query-audit.md) — tier 3: `query({ audit: true })` on the one sink.
7. [`07-mcp-surfaces-confirm.md`](07-mcp-surfaces-confirm.md) — tier 4: surfaces, request-aware tokens, audit hook, human confirm.
8. [`08-mail-ses-raw-events.md`](08-mail-ses-raw-events.md) — tier 4: SES driver, exact MIME, delivery events.
9. [`09-ai-models-documents.md`](09-ai-models-documents.md) — tier 4: Opus 5.5 row, document and image blocks.
10. [`10-admin-mcp.md`](10-admin-mcp.md) — tier 5: admin catalog names, read actions, scopes.
11. [`11-cli-mounts.md`](11-cli-mounts.md) — tier 5: mount `api/**/route.ts` and every MCP surface in `x dev` and `serve.ts`.
12. [`12-scaffold-papercuts.md`](12-scaffold-papercuts.md) — tier 5: rows 13–21.
13. [`13-docs-known-gaps.md`](13-docs-known-gaps.md) — docs: README, wiki, tutorial fixes, proposed Known-Gaps rows.

These can run in parallel: {02, 03, 04} after 01; {06, 07, 08, 09} after 05; 10 after 07; 11 after 05 and 07.

## Done when
- `apps/web/api/webhooks/test/route.ts` exporting `POST` answers under `x dev` and `serve.ts`. It
  verifies an HMAC over the exact bytes, reads a header, and a replay is detectable.
  `bun run scripts/reference-app-gate.ts` exercises it.
- One app serves `/mcp` and `/admin/mcp` with disjoint catalogs; a staff tool never appears on the
  customer surface. A mutating tool declared `confirm: 'human'` performs no side effect until an
  approving action runs.
- `query({ audit: true })` writes one sink record per read, allowed or denied.
- `entity({ appendOnly: true })`: `x db gen` emits the trigger, drift reports its absence, and
  `repo.update` is refused at type level and at runtime. This holds on PGlite and on Postgres.
- `s3Driver.put(key, bytes, { retention, legalHold })` succeeds against an Object Lock bucket
  (live test). Omitting the checksum is impossible.
- SES driver: send once, keep the exact MIME bytes, and normalise a bounce notification to a
  `DeliveryEvent`.
- An `llm()` with `model: 'claude-opus-5-5'` and a PDF document block builds a valid request body
  (unit test against the recorded wire shape).
- `addPlainMonths('2026-01-31', 1) === '2026-02-28'`, and a closure range expands to holidays.
- `x new` of a dotted name either keeps the name or says it renamed it. `x i18n add` seeds
  placeholders. Default locale has one source. The Helm uid matches the Dockerfile. The
  route→repo import is `X_BOUNDARY_ROUTE_TO_DB`. There is one role list.
- `bun run manifest`; `bun run changelog-check`; `bun run verify` green, all 20 steps.

## Risks / open questions
- **Falsified: AUTH_TABLES do not need hand-written migrations.** `FRAMEWORK_SCHEMA` applies them
  at every boot, `ROLE=migrate` included (`packages/cli/src/framework-schema.ts:30-94`).
  `wiki/Tutorial-03-Auth-And-Admin.md:185-187` is stale, and slice 13 fixes it.
- **Falsified: "no job-driver runtime accessor".** `jobDriver()` is exported
  (`packages/jobs/src/index.ts:110`), and so are `inspectQueues`/`inspectJob`
  (`packages/jobs/src/inspect.ts:29,113`). Dropped; slice 13 only documents it.
- **Partly false: "current model ids not accepted".** `claude-sonnet-5` and `claude-haiku-4-5`
  are registered (`models.ts:26-30,299-321`). `claude-haiku-4-5-20251001` is a dated id, and the
  undated alias is the right one. Only `claude-opus-5-5` is missing, and it has request rules the
  spec cannot express (slice 09).
- **Partly false: "admin requires `admin:write` even for reads".** This applies only to admin
  *actions* (`admin/src/action-gate.ts:37`). List, show and search tools gate on their own
  operation permission (`admin/src/mcp-tools.ts:171-183`). The real gap is that no action can be
  declared read-only (slice 10).
- **Partly false: "webhooks need a CSRF opt-out".** CSRF exempts anonymous and bearer callers
  (`http/src/csrf.ts:37-39,59`, stage note `pipeline.ts:67-70`). A public webhook route needs no
  opt-out, and none is planned.
- **Partly false: "`x new` silently renames".** The human line `cli.new.wrote` and `data.dir`
  both name the slugged dir (`cmd-new.ts:237,248`). The gap is that the rename is never *called*
  a rename, and that `--force` checks the slugged path.
- **Partly false: "`bin/dev` claims S3 → local dir without storage".** `x dev` does serve a local
  disk through the CLI's own dependency (`cli/src/dev-runtime.ts:32,165`). The gap is only that
  the app cannot import `@ultimat3/storage` without `bun add`.
- **Partly false: "an action cannot receive `text/plain`".** `bodyRaw()` returns the decoded
  string for `text/*` (`http/src/request.ts:221`). What an action cannot get is headers and the
  undecoded bytes.
- **Falsified workaround: "short-circuit it in app middleware".** `RuntimeOverrides.middleware`
  (`cli/src/runtime-overrides.ts:62`) is composed around *matched* route handlers only
  (`http/src/stages.ts:120-121`), and an unmatched path throws `X_ROUTE_NOT_FOUND` in the context
  stage first (`:171-173`). There is no in-framework way to receive a header-signed webhook today.
  That is why row 1 is blocks-app.
- **Needed no change: PGlite advisory locks.** `pg_advisory_xact_lock` and a plpgsql
  `before update or delete` trigger both work on PGlite 0.5.4 (PG 18.3), probed 2026-09-22.
- **By design, dropped: "e2e skipped by default".** A serial suite that ran nothing is recorded
  as skipped unless the repo's floor requires it (`cli/src/verify-run.ts:141-190`).
- **External fact, not code.** Among the inbound senders, SES delivery notifications (via SNS)
  are signed over a canonical string of fields, not the raw body. The payment-gateway case is the
  one that truly needs exact bytes plus a header. Slice 05 serves both.
- **Unverified: does S3 require an Object Lock checksum?** Whether S3 refuses an Object Lock PUT
  that has no `Content-MD5`/`x-amz-checksum-*` depends on the bucket configuration. Slice 03 makes
  the checksum unconditional, so the answer does not matter. Its live test is the proof.
- **Axiom 1 on raw routes.** `defineApiRoute` is a second way to answer `POST /api/...`. The
  guardrails:
  - a non-blank `why` (the `unenforced` pattern);
  - `X_API_ROUTE_CONFLICT` when its path shadows an action or query route;
  - the http README states the rule: an action unless you need bytes, headers or a foreign
    protocol.

  If review rejects that, the alternative is `action({ http: { raw: true } })` exposing
  `bodyBytes`/`headers` to `handle`. That reopens `wiki/Actions.md:96`, so it was not chosen.
- **Confirm design (slice 07).** A durable pending call approved by a human action was chosen
  over an agent-echoed confirm token: a token only proves the agent asked twice. Reopen this only
  if a downstream app needs agent-side confirmation.
- **Plan 101 overlap.** 101's tree is on this branch (`71f7c6b0`). Slices 11 and 12 edit
  `serve.ts`, `dev-route-table.ts` and scaffold templates that 101 slices 14 and 16 also touch.
  Rebase and re-read the line numbers before editing. None of the rows above is addressed by 101.
- **Pricing to re-check.** The `claude-sonnet-5` row prices $3/$15 per MTok (`models.ts:299-306`,
  and the comment says list price). A cached 2026-06 price table shows $2/$10. Verify against the
  pricing page before touching it; slice 09 does not change it.
- New codes (each through `bun run scripts/new-error-code.ts`, rows in `wiki/Error-Codes.md`):
  - `X_API_ROUTE_UNDECLARED`, `X_API_ROUTE_CONFLICT` (http)
  - `X_HMAC_SIGNATURE_INVALID` (http)
  - `X_ENTITY_APPEND_ONLY` (entity), `X_APPEND_ONLY_TRIGGER_MISSING` (db)
  - `X_MCP_SURFACE_DUPLICATE`, `X_MCP_CONFIRMATION_REQUIRED`, `X_MCP_CONFIRMATION_EXPIRED`, `X_MCP_CONFIRM_UNSAFE` (mcp)
  - `X_MAIL_EVENT_UNRECOGNIZED` (mail)
  - `X_STORAGE_RETENTION_INVALID` (storage)
  - `X_AI_CONTENT_UNSUPPORTED` (ai)
