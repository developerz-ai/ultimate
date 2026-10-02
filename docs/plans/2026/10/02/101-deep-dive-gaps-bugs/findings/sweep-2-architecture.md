# Sweep 2 — architecture coherence (CLI, tiers 4–5, docs, tracked apps)
> Re-checked in [`sweep-3-verify-tier-4-5.md`](sweep-3-verify-tier-4-5.md) — where it corrects a citation or narrows a row, that file wins.

> Findings for [`../overview.md`](../overview.md). Read-only sweep at `2ea5eb17` (23.0.0), As of 2026-10.
> Scope: what [`sweep-1-architecture.md`](sweep-1-architecture.md) did not examine. No row of that
> file or of the 2026-09-28 audit's slices 08 / 09 is repeated.
> `bun run boundaries` and `bun run verify` were not run by this pass.

## High

| # | Rule | Evidence | Cost | Delete / unify | Guard | Owner call? |
|---|---|---|---|---|---|---|
| H1 | axioms 1, 3 — dead declaration | `packages/render/src/registry.ts:41-44` declares `ROUTE_FILENAME.api = 'route.ts'`; `:170-174` tells authors to name it so. `packages/render/src/modes.ts:186-192` refuses every `api` surface with `X_ROUTE_MODE_INVALID`; `registry.ts:288` calls it on each registration; `modes.test.ts:333` pins it. Promise restated in root `CLAUDE.md` (Conventions), `docs/architecture/12-generated-app.md:155-160`, `x routes --surface …\|api\|shared`. Neither tracked app has a `route.ts`; `x g route` takes `site\|app` only | an agent told "`route.ts` on `api/`" writes a file the framework names and always rejects | `ROUTE_FILENAME.api`; the `api` branches in `packages/cli/src/live-routes.ts:186`, `site-seo.ts:123`; the `api` / `shared` choices on `x routes --surface`; "Rule one" in the doc. Keep `api` as an import-boundary surface only | a test registering one route per `ROUTE_FILENAME` key | no |
| H2 | axioms 1, 2, 4 | `packages/http/src/router.ts:333-334` `describeRoutes` says it "feeds the `/_x` dashboard, the manifest emitter and `x routes list --json`" — none reads it; callers are `server.ts:233,253,270` only. `x routes`, manifest, dev panel, MCP read `packages/render/src/registry.ts:391` — page routes only. `x routes --json --cwd examples/dummy` → 57 routes, all `site` / `app`: no action POST, query GET, bearer mount, health route. Route-miss fix lines (`packages/http/src/errors.ts:169,364`, `server.ts:42`) say `x routes list --json` — a retired spelling that runs only because a stray positional is ignored | "what URLs does this process answer" has two tables; the 404's own fix points at the one that cannot contain the route | `x routes` reads the composed served table (page routes + `apiRoutes()` / `apiMountRoutes()` through `describeRoutes`), or delete `RouteDescription` and `Server.describe()` and rewrite the three fix lines. Refuse unknown positionals | `scripts/doc-fixes.ts` executes each `fix:` command shape against the registry, positionals included | yes — which table |
| H3 | axiom 1 — duplication, already diverged | three raw-CDP page drivers: scraping (`cdp-a11y`, `key-chord`, `actionability`, `clock`, `driver-cdp`), cli (`cdp-shot-a11y`, `cdp-shot-keys`, `cdp-shot-element`, `cdp-shot-clock`, `cdp-shot-page`, ~1,100 LOC), testing (`cdp-e2e-page`, `cdp-connection`, `cdp-launch`). Residue of the `cli → scraping` edge deleted in 22.0.0 (`docs/history/tier-decisions.md:5`). `packages/scraping/src/key-chord.ts:36-60` accepts any non-empty key (`X_SCRAPE_KEY_INVALID`); `packages/cli/src/cdp-shot-keys.ts:25-70` a closed `NAMED_KEYS` table (`ShotKeyInvalidError`) | one chord, two grammars, two codes | the four `cdp-shot-{a11y,keys,element,clock}.ts`, in favour of scraping's — needs scraping at its real floor (tier 4, [`sweep-1-architecture.md`](sweep-1-architecture.md) row 5), making `cli → scraping` an ordinary downward edge | a parity test over one chord corpus until one copy is gone | follows row 5's decision |
| H4 | axioms 1, 3, 8 | `packages/cli/src/app-transport.ts:1-3`: "built in rather than a file in `guards/` — a rule an app can delete is a rule the next agent deletes". `packages/cli/src/templates/scaffold-guards.ts` ships the non-negotiables (raw colour, untranslated string, unzoned date, bare error, raw SQL in repos) as string-literal source copied into each app — 3,275 lines per tracked app, a third copy as templates. `packages/cli/src/doctor-guards.ts:19-25` detects a missing guard, never a stale one; `wiki/Upgrading.md:105`: "upgrading installs no guard" | a guard fix in N+1 never reaches an app scaffolded on N; the non-negotiables are one `rm` from unenforced | `guards/<name>.ts` becomes a one-line re-export of a framework-owned guard module (deleting the file still drops the rule; the body upgrades with the package) — or move the five into `boundaries` beside `app-transport` | `x doctor` compares each held shipped guard to the installed version | yes |
| H5 | framework gap, evidenced by an app | `dummy/social-media-clone` imports none of `@ultimat3/auth`, `storage`, `notify`, `time`, `mail`, `seo`. It hand-writes ~1,495 lines of auth: `apps/web/shared/session.ts`, `apps/web/app/auth/password.ts`, `apps/web/app/auth/service.ts:27-38` (a per-process failure counter the file calls "wrong for a fleet"). `DOMAIN.md:29` says sessions are "framework-owned via `@ultimat3/auth`"; `:81` promises a `requestUpload` action that does not exist. `x new` wires no session (`wiki/Known-Gaps.md:35`); only `examples/dummy` reaches `defineAuth`, through OAuth (`apps/web/app/auth/login.ts:9`) | an agent copying the deployed demo re-implements a tier-2 package; nothing proves the password flow composes with a real app | the clone's `shared/session.ts`, `app/auth/password.ts`, the session half of `service.ts`, in favour of `defineAuth` — or correct `DOMAIN.md` and record the gap that stopped it | "every package in tiers 1–4 is imported by a tracked app, or pinned with a reason", in the style of `scripts/primitive-factories.test.ts` | yes |

## Medium

| # | Rule | Evidence | Delete / unify | Owner call? |
|---|---|---|---|---|
| M1 | axiom 1 | `x g resource widget` writes `app/widget/actions/create-widget.ts`, `live/…`, `jobs/…`, page at `app/widgets/`; `packages/cli/src/api-registration.ts:22-23` recognises the directory form only. Both tracked apps use flat `actions.ts` / `jobs.ts` / `live.ts`. `docs/architecture/12-generated-app.md:126`: "nothing enforces either layout" | one layout. Cheaper: the flat files in the two apps. Guard: generate a resource into the reference app in CI, assert no sibling `X.ts` + `X/` | yes |
| M2 | eight primitives — medium confidence | `packages/realtime/src/channel-decl.ts:96` has its own registry, authz (`channel-authz.ts`), `describeChannels`, a manifest section (`packages/manifest/src/schema.ts:278`), a contract diff (`diff-channels.ts`), a client hook. Returns a `Channel`, not a `query` — no `x channels`, no OpenAPI row, no MCP tool. Not in `PRIMITIVE_KINDS` / `PRIMITIVE_FACTORIES`; no doc argues the exception (as `packages/flags/CLAUDE.md:20` does for `flag`). `notify` exports an unrelated `channel()` (`packages/notify/src/channel.ts:54`) | `channel()` as a factory over `query` (it already takes `QueryPolicy`) with a `PRIMITIVE_FACTORIES` row — or the argued exception. Rename notify's | yes |
| M3 | axiom 2 | `packages/action/src/mcp-tool.ts` (`toMcpTool`, the body of `.tool()`, taught at `wiki/Actions.md:54`) emits full draft-07; `packages/mcp/src/projectable.ts:59,99` builds its own from `toWireSchema`; `from-action.ts:16-25` says the two "are not interchangeable". `packages/mcp/src/validate-args.ts` (236 LOC) is a second validator in front of `invoke`'s parse. `packages/ai/src/tools.ts:112` hands a model the full shape again | `validate-args.ts` for projected primitives; `mcpSchemaOf` in action. Move `narrow()` to `schema` so `.tool()` returns the served shape | no |
| M4 | axiom 1 | `x test --workers N --worker I` is 0-based (`packages/cli/src/cmd-test.ts:186-192`); `x verify --only unit --shard i/n` is 1-based, corpus-hashed, merge-proved (`verify-shard.ts:28-45`). CI uses only the second | `--worker`, its `X_TEST_SHARD_FAILED` path, `ULTIMATE_TEST_WORKER` | no |
| M5 | dead declarations | `packages/pwa/src/capabilities.ts:7-14` lists six; `packages/core/src/config-pwa.ts:51-52` has `backgroundSync`, `push`; `push` is inert — no `pwa.vapid` key (`packages/cli/src/sw-artifacts.ts:222-228` warns), no sender. `subscribeSource`, `renderPushPayload`, `subscriptionState`, `routeRules`, `assetRules`, `resolveCapabilities`, `registerBackgroundSyncSource` have zero consumers | wire (`pwa.vapid` + a `notify` push channel) or delete `push.ts`, four flags, the `pwa.push` key | yes |
| M6 | driver parity | "which store backs this seam" is a per-app ternary with three predicates: `packages/cli/src/templates/scaffold-db-client.ts:90` (`env === 'test'`), `examples/dummy/apps/web/app/runs/keys.ts:33` (re-typed), `dummy/social-media-clone/apps/admin/app/admin/admin.ts:101` (`DATABASE_URL` set) — under `x dev` with embedded PGlite the audit log is in memory while every repo is on Postgres | one core `storeMode(env)`, or each `postgres*()` resolves the process client | no |
| M7 | framework gaps | reference-app workarounds: `examples/dummy/apps/web/shared/ui-strings*.ts`, `plural-*.ts` (`t()` cannot cross into an island — `wiki/Known-Gaps.md:92`); `shared/wire.ts` (a query declares no output schema — a `Date` column arrives as a string; not in Known-Gaps); `shared/queued-writes.ts` (outbox depth inferred from `useMutation` resolving `undefined`; not in Known-Gaps) | i18n ships an island catalog subset; the query client revives dates or types them `string`; realtime exposes the outbox count | yes — which projections |

## Low

| # | Evidence | Delete / unify |
|---|---|---|
| L1 | CLI verbs differ per command: `list` / `ls` / `--list` / `tools`; `describe` / `show` / `explain`; `rm` / `drop`; `--check` flag vs `check` subcommand; `--timeout 15m` (deploy) vs `<ms>` (shot) | one verb each; breaking — pair with a major. Guard: a spec lint over `LAZY_COMMANDS` |
| L2 | `RouteBudget.lcp` has a comparator and no writer (`packages/cli/src/budgets.ts:44-51`: "written by nothing"); `examples/dummy/apps/web/site/page.tsx:21` declares `lcp: 1200` | the key, the `lcpMs` branch, the `_EveryBudgetKeyIsProjected` arm |
| L3 | `'ULTIMATE_TEST_ISOLATED'` spelled three times: `packages/testing/src/isolated-plugins.ts:13`, `preload.ts:59`, `packages/cli/src/test-shards.ts:56` | the two copies |
| L4 | `packages/cli/src/error-catalog.ts:47-62` calls `admin` and `ui` optional hosts; `packages/cli/package.json` hard-depends on admin, `cmd-dev.ts:8` imports it | the two entries |
| L5 | `isoInZone` lives in `packages/cli/src/tasks-facts.ts:33`; its comment says `time` lacks the export | move to `time` |
| L6 | the demo hard-codes the display locale on dates — six `new Intl.DateTimeFormat('en', …)` sites (`dummy/social-media-clone/apps/web/site/feed/page.tsx:35`, `app/messages/page.tsx:100`); `unzoned-date` passes because a zone is given | extend the guard to route raw `Intl.DateTimeFormat` to the framework formatter |
| L7 | `cli` is also the production runtime: `runtime-*`, `serve*`, `role-*` ~5,100 LOC beside the commands (`serve-entry.ts:1-3`, `registry.ts:4-7` record the cost). Low confidence | extraction candidate; owner call |
| L8 | a full Postgres v3 client in `realtime` (`pg-wire`, `pg-auth`, `pg-tls`, `pg-socket`, `pg-connection`, `pgoutput`, ~8,400 lines with tests). Need argued (`docs/architecture/07-realtime-internals.md:106`), placement not. `sslmode` has two implementers — one `DATABASE_URL` can behave differently in `web` and `replicator`. Low confidence | owner call |

## Doc drift

| Where | Says | Reality |
|---|---|---|
| root `CLAUDE.md` (Conventions) | `route.ts` on `api/`, enforced by `registerRoute()` | every `api` route is refused (`packages/render/src/modes.ts:187`) |
| `docs/architecture/12-generated-app.md:155-160` | Rule one: a raw HTTP route you own | unreachable |
| `packages/http/src/router.ts:333` | feeds dashboard, manifest, `x routes list` | no such consumer |
| `packages/http/src/errors.ts:169,364`, `server.ts:42` | fix: `x routes list --json` | retired spelling; the list omits API routes |
| `wiki/CLI-Reference.md:1347` | a planned command with a flag fails `X_CLI_BAD_FLAG` | `x upgrade --dry-run --json` → `X_NOT_IMPLEMENTED`; `wiki/Known-Gaps.md:121` says fixed in 4.0.0 |
| `wiki/CLI-Reference.md:1126`, `:566-570` | `--workers` default `ceil(cpus*1.5)`, 1.5 GiB a worker | 1.25 GiB of a `min(4 GiB, …)` budget (`packages/cli/src/test-workers.ts:67`); `:504` is right |
| `wiki/CLI-Reference.md` index | `x build`: three targets; `x mcp serve` only; "As of 2026-08" | four targets (`prebuilt`); `x mcp tools` exists |
| `packages/cli/src/cmd-manifest-spec.ts` usage | `x manifest [--check] [--json]` | an `openapi` flag is declared; the wiki shows `--no-openapi` |
| `packages/cli/src/cmd-planned.ts:21` | the wiki's table "verbatim" | `branch` and `money` fix strings differ from `wiki/CLI-Reference.md` |
| `wiki/PWA-And-Offline.md:274,277` | `push` generates a subscription action and a fan-out job; `shareTarget` a POST route | none is generated |
| `docs/architecture/02-boundaries.md:46-47` | `raw-hex`, `hardcoded-string`, `date-no-tz`: "no checker implements" | shipped as `raw-colour`, `untranslated-string`, `unzoned-date` |
| `dummy/social-media-clone/DOMAIN.md:29,81` | sessions via `@ultimat3/auth`; a `requestUpload` action | neither exists |
| `packages/auth/src/verify.ts:4` | mail is "a sideways tier-3 package" | mail is tier 4 |
| `scripts/readme-fences-backlog.ts` | — | 155 of 170 README code fences do not typecheck (ratcheted) |

## Not a problem (do not re-open)

- Axiom 6 — measured in both apps' `.x/build-stats.json`: every static `site/` route is `jsBytes: 0`. Local artefacts, not a fresh build.
- `framework.manifest.json` and the app manifest projections are derived, not hand-listed.
- CI `gate` parts cover all 20 `VERIFY_STEP_NAMES`; `x verify merge` refuses an unreported step.
- Registered commands vs wiki vs `PLANNED_COMMANDS` — 28 shipped, 9 planned, name for name. Every spec carries `--json`.
- Tier floor — enforced; no package above its floor without a row; no undeclared runtime edge.
- Doc `import { … } from '@ultimat3/…'` statements — all 24 misses are before / after migration lines.
- UI raw colours and hardcoded strings — none in components; raw `rgb()` only in `tokens/_shadow.scss`.
- Four drift rails + `cli/schema-diff.ts` vs db `diffSchema` — each compares a different pair.
- `pwa/background-sync.ts` is not a second outbox.
- Structural tier seams (`notify` mailer, auth `MailSender`, `PolicyActorFields`, manifest `ADMIN_MOUNTS_KEY`) — argued, values agree.
- `realtime/nats-fake.ts` sits behind `transport-parity.test.ts` and a live test.

## Still not examined

- `render` SSR / hydration internals; realtime client store parity with the server; `db/migrate.ts` replay engine.
- Admin CRUD / list internals; mail templates and SMTP client.
- `docs/ops/`, `llms.txt`, `CHANGELOG.md`, tutorials, `wiki/Error-Codes.md`, per-package `CLAUDE.md` bodies.
