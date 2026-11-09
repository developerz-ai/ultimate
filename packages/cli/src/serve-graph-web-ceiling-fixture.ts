// The web role's serve-graph module count, each raise stated with its number and reason. Split
// from `serve-graph-ceilings-fixture.ts` at the file ceiling; `serve-graph.test.ts` holds a build
// to it. A raise names the modules, often by pointing at the other two ledgers' entries.

/**
 * measured: 888 — the 796 `SERVING_ROLE_CEILING` measured (`serve-graph-ceilings-fixture.ts`)
 * plus the 92 `serve-web.ts` adds (41 CLI, 36 MCP, 15 PWA).
 * raised 975 → 980, measured 980 (2026-10-05, plan 101 sweep 1c): the same five modules named on
 * `SERVING_ROLE_CEILING`, which every role carries.
 * raised 980 → 982, measured 982 (2026-10-05, plan 101 sweep 2): the same two modules named on
 * `SERVING_ROLE_CEILING` for sweep 2.
 * raised 982 → 984, measured 984 (2026-10-05, plan 101 sweep 7): `core/src/metrics.ts` hit the
 * 500-line ceiling and split by responsibility into `metric-errors.ts`, `metric-registry.ts` and
 * `metric-series.ts` (+3), and `storage/src/driver-s3-absent.ts` left `driver-s3.ts` (+1); the
 * action and query `deprecation.ts` copies collapsed into one `core/src/deprecation.ts` (−1 net).
 * raised 984 → 987, measured 987 (2026-10-05, plan 101 sweep 8b, native Windows): the two modules
 * named on `SERVING_ROLE_CEILING` for sweep 8b, and `cli/src/island-package-dedupe.ts` — the island
 * build resolves every `@ultimat3/*` import to the app's one copy, which a Windows `file:` install
 * without symlinks had bundled twice (+15 KB on `/posts`).
 * raised 987 → 992, measured 992 (2026-10-05, plan 101 sweep 8c): the five modules named on
 * `SERVING_ROLE_CEILING` for sweep 8c.
 * raised 992 → 994, measured 994 (2026-10-05, plan 101 sweep 9): `render/src/island-hold.ts` (named on
 * `SERVING_ROLE_CEILING`, #506) and `cli/src/island-runtime.ts` (#505: the page runtime built once
 * per page instead of inlined into every realtime island; split out so `island-bundle.ts` stays
 * under the ceiling).
 * raised 994 → 998, measured 998 (2026-10-05, plan 101 sweep 9b): `cli/src/theme-brand.ts` (the one
 * reader of an app's `apps/web/shared/theme.ts` brand, inlined with its CSP hash), and the island
 * build's duplicate-module guard — `island-duplicates.ts` (detection), `island-duplicate-refusal.ts`
 * (refuse a framework duplicate, warn on a third-party one) and `island-entry-missing.ts` (the
 * refusals moved out so `island-bundle.ts` stays under the 500-line ceiling).
 * raised 998 → 1004, measured 1004 (2026-10-06, plan 101 sweep 10a): the six modules named on
 * `SERVING_ROLE_CEILING` for sweep 10a.
 * raised 1004 → 1011, measured 1011 (2026-10-06, plan 101 sweep 10b): the seven modules named on
 * `SERVING_ROLE_CEILING` for sweep 10b.
 * raised 1011 → 1024, measured 1024 (2026-10-06, plan 101 sweep 10c): the five named on
 * `SERVING_ROLE_CEILING` for 10c, MCP human confirmation and its audit hook on the web role —
 * `mcp/src/confirmations.ts`, `confirmation-gate.ts`, `confirmation-store.ts`,
 * `confirmation-postgres.ts`, `confirmation-errors.ts`, `audit-hook.ts`, `confirmation-decide.ts` (an approval
 * must carry back the exact arguments `view` showed, compared by keyed digest) — and
 * `mcp/src/errors-transport.ts`, the transport error classes split out so `errors.ts` stays under
 * the 500-line ceiling once the eight confirmation codes are registered.
 * raised 1024 → 1026, measured 1026 (2026-10-06, plan 101 sweep 10d): the two modules named on
 * `SERVING_ROLE_CEILING` for 10d (`admin/src/mcp-scopes.ts` is behind the admin mount's lazy import).
 * raised 1026 → 1029, measured 1029 (2026-10-06, plan 101 sweep 11): the three modules named on
 * `SERVING_ROLE_CEILING` for 11.
 * raised 1029 → 1030, measured 1030 (2026-10-06, plan 101 sweep 11b): `realtime/src/nats-subscriptions.ts`,
 * named on `SERVING_ROLE_CEILING` for 11b.
 * raised 1030 → 1032, measured 1032 (2026-10-07, plan 101 sweep 12c): the two modules named on
 * `SERVING_ROLE_CEILING` for 12c.
 * raised 1032 → 1035, measured 1035 (2026-10-07, sweep 13a): the three modules named on
 * `MIGRATE_CEILING` for 13a — the web role reaches every module the serving roles do.
 * raised 1035 → 1036, measured 1036 (2026-10-07, sweep 13b): `jobs/src/errors-tenant.ts` — the terminal
 * `X_JOB_TENANT_MISMATCH` a webhook delivery or a queued agent refuses a wrong org with.
 * raised 1036 → 1037, measured 1037 (2026-10-07, sweep 14): `entity/src/transition-pins.ts` — the
 * columns a transition's policy read, pinned into its compare-and-set (#702).
 * raised 1037 → 1038, measured 1038 (2026-10-07, 26.0.0 app feedback): `core/src/log-tee.ts` — `addLogSink`,
 * the supported log tee, reached through `logger.ts` by every module that logs (retired in 31.0.0:
 * the tee is `subscribe('log.record', …)` on core's instrumentation bus).
 * raised 1038 → 1039, measured 1039 (2026-10-08, 26.1.0): the module named on
 * `SERVING_ROLE_CEILING` for route-presented modals.
 * raised 1039 → 1053, measured 1053 (2026-10-08, Web Push): the two modules named on
 * `SERVING_ROLE_CEILING`, and the twelve the `@ultimat3/pwa` barrel the web role already loads now
 * carries — RFC 8291 encryption and its receiving half, the RFC 8292 signer and its key pair, the
 * sender, the runtime, the two stores, the subscribe actions and the client's meta name
 * (`installedVapid()` feeds `sw.js`'s push handler and `<meta name="x-push-key">`).
 * raised 1053 → 1054, measured 1054 (2026-10-08, 26.1.0 browser entry): `pwa/src/skew.ts` —
 * `detectSkew` and `AppUpdateAvailable`, split from `version-skew.ts` so `@ultimat3/pwa/client`
 * carries them without the error table; the web role reaches it through the pwa barrel.
 * raised 1054 → 1055, measured 1055 (2026-10-08, 26.1.0): `pwa/src/push-hosts.ts` — the push
 * services the sender may dial, checked at subscribe and at send (an endpoint from a request body
 * resolves wherever its owner points it), reached through `push-send.ts`.
 * raised 1055 → 1056, measured 1056 (2026-10-09, 27.2.0): `storage/src/errors-promote.ts`, the
 * module named on `SERVING_ROLE_CEILING` for 27.2.0.
 * raised 1056 → 1058, measured 1058 (2026-10-09, #738): the two core modules named on `MIGRATE_CEILING`.
 * raised 1058 → 1060, measured 1060 (2026-10-09, #710): the two modules named on
 * `MIGRATE_CEILING` for #710.
 * raised 1060 → 1061, measured 1061 (2026-10-09, #710 row 9): `auth/src/login-identity.ts`, the
 * module named on `MIGRATE_CEILING`.
 * raised 1061 → 1062, measured 1062 (2026-10-10, channel events from app code): the module named
 * on `SERVING_ROLE_CEILING`, which every role carries.
 * raised 1062 → 1063, measured 1063 (2026-10-10, events-only islands are never held):
 * `cli/src/island-realtime-state.ts` — which realtime islands read the record store or the outbox
 * (held, #506) and which only follow a channel, read off the names each imports from the barrel.
 * raised 1063 → 1065, measured 1065 (2026-10-10, #752): the two entity modules named on
 * `MIGRATE_CEILING` for #752.
 * raised 1065 → 1066, measured 1066 (2026-10-10, the bus is not a boot dependency of a publisher):
 * `cli/src/runtime-bus.ts`, the module named on `SERVING_ROLE_CEILING`, which every role carries.
 * raised 1066 → 1067, measured 1067 (2026-10-10, PR #755 review): `realtime/src/nats-dial-wait.ts`,
 * the module named on `SERVING_ROLE_CEILING`.
 * raised 1067 → 1072, measured 1072 (2026-10-10, isr purge + keyed query): the five render
 * modules named on `SERVING_ROLE_CEILING`, which every role carries.
 * raised 1072 → 1073, measured 1073 (2026-10-11, PR #757 review): `cli/src/isr-query-guard.ts` —
 * the `query` a page is handed; outside production it says once when an `isr` page reads a
 * parameter its `revalidate.query` does not list (one stored document for every value of it).
 * raised 1073 → 1078, measured 1078 (2026-10-11, a channel recovers after a bus outage): the five
 * modules named on `SERVING_ROLE_CEILING` — the web role reaches every module the serving roles do.
 * raised 1078 → 1080, measured 1080 (2026-10-11, an isr page is one entry however its URL is
 * spelled): the module named on `MIGRATE_CEILING`, and `cli/src/runtime-address.ts` — the URL a
 * `static` or `isr` document is rendered at and kept under, the address the router matched.
 * raised 1080 → 1085, measured 1085 (2026-10-11, sitemap sections): the five modules named on
 * `SERVING_ROLE_CEILING` — the web role reaches every module the serving roles do.
 * raised 1085 → 1086, measured 1086 (2026-10-14, #773): the module named on `MIGRATE_CEILING`.
 * raised 1086 → 1087, measured 1087 (2026-10-17, a DB blip degrades the limiter): the module named
 * on `MIGRATE_CEILING`.
 * raised 1087 → 1091, measured 1091 (2026-10-17, #790): the four modules named on
 * `SERVING_ROLE_CEILING` for #790.
 * raised 1091 → 1094, measured 1094 (2026-10-18, F13 `surface: 'meta-split'`): `mcp/src/meta-split.ts`
 * (the three dispatchers and the effect boot check), `meta-split-call.ts` (their dispatch: wrong tool,
 * preview, `confirmed_by_user`) and `meta-host.ts` (the server half both meta doors call, moved out of
 * `meta-call.ts` so neither imports the other).
 * raised 1094 → 1095, measured 1095 (2026-10-20, an unknown predicate operator is refused): the one
 * module named on `MIGRATE_CEILING` for that change, `entity/src/operator.ts`.
 * raised 1095 → 1097, measured 1097 (2026-10-22, Bun idle timeout + `seo.robots.groups`): the
 * two modules named on `MIGRATE_CEILING` for that change.
 * raised 1097 → 1098, measured 1098 (2026-10-26, a filtered update judged as ONE batch): the one
 * module named on `MIGRATE_CEILING` for that change — the web role reaches every module the
 * serving roles do.
 * raised 1098 → 1100, measured 1100 (2026-10-28, `jobWorker({ maxInFlight })`): the two modules
 * named on `MIGRATE_CEILING` for that change.
 * raised 1100 → 1101, measured 1101 (2026-10-29, `navigation: { modal: true, prefetch: 'intent' }`):
 * the one module named on `SERVING_ROLE_CEILING` for that change.
 * raised 1101 → 1121 (2026-10-31): `indexes: [{ concurrently: true }]` (+6) and `query({ download })`
 * with ranged reads (+14) — the modules named on `SERVING_ROLE_CEILING` for each.
 * raised 1121 → 1149, measured 1149 (2026-11-02, plan 101 wave 1): the modules named on
 * `SERVING_ROLE_CEILING` for it and `cli/src/runtime-render-document.ts`, the document split out of
 * `runtime-render.ts` for the web role, less what earlier raises left as slack.
 * raised 1149 → 1179, measured 1179 (2026-11-03, plan 101 wave 2): the 29 named on
 * `SERVING_ROLE_CEILING` for it and `cli/src/stream-hole-scope.ts`, a `<Hole>`'s request scope.
 * raised 1179 → 1200, measured 1200 (2026-11-03, plan 101 wave 3): the 21 named on
 * `SERVING_ROLE_CEILING` for it; the web role adds no new module of its own.
 * raised 1200 → 1213, measured 1213 (2026-11-03, plan 101 wave 4a): `SERVING_ROLE_CEILING`'s 12,
 * and `cli/src/plain-routes.ts` — `runtime.routes` plus every declared `webhookReceiver()`'s, the
 * one list both boots mount and `x routes` prints.
 * raised 1213 → 1222, measured 1222 (2026-11-03, plan 101 wave 4b): `SERVING_ROLE_CEILING`'s 2;
 * browser error reporting, `cli/src/client-errors-{routes,script}.ts` (mounted when
 * `clientErrors.enabled`); and `assets.retain`, `cli/src/retained-assets{,-boot,-layout,-read,
 * -sweep}.ts` — the publish before `/readyz` and the reader every asset route's 404 asks. Measured
 * against a copy of HEAD with its own workspace links: no existing module newly reached.
 * raised 1222 → 1226, measured 1226 (2026-11-03, plan 101 wave 4c): `SERVING_ROLE_CEILING`'s 1,
 * and MCP's dual era — `mcp/src/protocol-era.ts` (the era per request, `server/discover`, the
 * mirrored-header check), plus `server-resources.ts` and `transport-http-answers.ts`, split out
 * of `server.ts` and `transport-http.ts` at their line ceilings. No existing module newly reached.
 * raised 1226 → 1232, measured 1232 (2026-11-05, plan 101 wave 5a): the same six as
 * `SERVING_ROLE_CEILING`'s row; the web role adds nothing of its own.
 * raised 1232 → 1236, measured 1236 (2026-11-05, plan 101 wave 5b): `SERVING_ROLE_CEILING`'s 3,
 * plus `cli/src/page-pins.ts`, which collects the pins a rendered document stamps.
 * raised 1236 → 1237, measured 1237 (2026-11-05, plan 101 wave 6a): `MIGRATE_CEILING`'s 1.
 * raised 1237 → 1296, measured 1296 (2026-11-06, plan 101 wave 7): `SERVING_ROLE_CEILING`'s 58,
 * plus `mcp/src/oauth-server.ts` (`mcpAuthorizationServer`), through the MCP barrel the web role
 * mounts.
 * raised 1296 → 1321, measured 1321 (2026-11-06, plan 101 wave 8): `SERVING_ROLE_CEILING`'s 23,
 * plus `cli/src/client-vitals-{route,script}.ts`, the page-vitals beacon and its script.
 * raised 1321 → 1390, measured 1390 (2026-11-06, plan 101 wave 9): `SERVING_ROLE_CEILING`'s 47,
 * plus `cli/src/{site-llms,zone-boot}.ts` and the MCP barrel's new modules the web role mounts —
 * `mcp/src/{job-tool,job-tool-errors,job-status-tool,recipes,recipes-tool,recipes-surface,
 * recipe-errors,recipe-links,recipe-markdown,recipe-replay,recipe-search,remote-client,
 * remote-errors,remote-listen,remote-lock,remote-oauth,remote-schema,remote-tools,remote-wire,
 * dev-graph-tool}.ts`. No existing module newly reached.
 * raised 1390 → 1392, measured 1392 (2026-11-06, plan 101 wave 9): `SERVING_ROLE_CEILING`'s 2.
 * raised 1392 → 1397, measured 1397 (2026-11-07, plan 101 wave 10): `SERVING_ROLE_CEILING`'s 2, plus
 * `cli/src/runtime-assets-site{,-cache}.ts` (a served `/assets` image's declared variants) and
 * `cli/src/site-llms-pages.ts` (`llms.txt`'s page reads). No existing module newly reached.
 * raised 1397 → 1398, measured 1398 (2026-11-07, plan 101 wave 10): `MIGRATE_CEILING`'s `core/src/hmac.ts`.
 * raised 1398 → 1434, measured 1434 (2026-11-07, #990–#999): `SERVING_ROLE_CEILING`'s 27, plus the
 * web role's MCP `mcp/src/{app-catalog,catalog-errors,confirmation-{approvers,evidence,quorum-errors},
 * runtime-schema,runtime-tool,server-catalog,tenant}.ts`.
 * raised 1434 → 1435, measured 1435 (2026-11-07, sweep 2): `db/src/drift-missing.ts`, split off drift-findings.
 * raised 1435 → 1436, measured 1436 (2026-11-07, fix/exercise-tenancy): `entity/src/read-only.ts`.
 * raised 1436 → 1441, measured 1441 (2026-11-07, sweep 3): the four above, `mcp/src/include-early.ts`.
 * raised 1441 → 1442, measured 1442 (2026-11-07, fix/exercise-fidelity): `MIGRATE_CEILING`'s 1.
 * raised 1442 → 1443, measured 1443 (2026-11-08, fix/followups): `MIGRATE_CEILING`'s 1.
 * raised 1443 → 1458, measured 1458 (2026-11-09, plan 101 v31 wave A): `SERVING_ROLE_CEILING`'s 15.
 * raised 1458 → 1476, measured 1476 (2026-11-09, plan 101 v31 wave B): `SERVING_ROLE_CEILING`'s 17
 * and `mcp/src/meta-catalog-render.ts` (the web role's MCP catalog, split). No existing module
 * newly reached.
 * raised 1476 → 1485, measured 1485 (2026-11-09, plan 101 v31 wave C, slice 20):
 * `SERVING_ROLE_CEILING`'s 9. No existing module newly reached.
 * raised 1485 → 1486, measured 1486 (2026-11-09, plan 101 v31 wave C gate fix):
 * `SERVING_ROLE_CEILING`'s 1, `core/src/instrument-stacks.ts`. No existing module newly reached.
 */
export const WEB_ROLE_CEILING = 1486;
