# 06 — CLI, guards, testing harness, CI

> Part of [`overview.md`](overview.md). Depends on: 05 merged. Tier: 5 + `scripts/` + `.github/`. **Sweep 6.**
> Probed at `d7b8c7fa` unless *read*. Deploy-breaking cli rows (helm tag, replicator rollout, stop
> sequence) already landed in [`02-data-integrity.md`](02-data-integrity.md) D8–D11. As of 2026-10.

## Rule
A guard that a real form slips past is a guard that does not exist (axiom 3). Every guard row below
ships with the slipping form as a test case.

## Agents (≤ 4, disjoint)
| Agent | Exclusive paths |
|---|---|
| A — cli runtime | `packages/cli/src/{root-env,runtime-render,dev-route-table,dev-traces,island-harness-route,island-store,bin,dev-lock,cmd-new,messages,dev-supervisor,dispatch}.ts`, `cmd-dev.ts` (`:246`, `:404` only) + tests |
| B — cli commands + admin | `packages/cli/src/{cmd-jobs,cmd-jobs-spec,cmd-planned,cmd-mcp,cmd-shot,cmd-shot-spec,cmd-shot-matrix,db-subscribes,schema-diff}.ts`, new `shot-viewport.ts`, `packages/admin/src/form-decode.ts`, `packages/schema/src/coerce.ts` (export only) + tests, `wiki/CLI-Reference.md` |
| C — guards (repo + shipped) | `scripts/{boundaries,node-imports,test-bare-error}.ts`, `packages/cli/src/import-scan.ts`, `biome.json`, `packages/cli/src/templates/{guard-unzoned-date,guard-bare-error}.ts` + both tracked apps' `guards/` copies (byte-equal) |
| D — CI + test harness | `.github/workflows/ci.yml`, `docker/docker-compose.test.yml`, `docker/test-services.env`, `scripts/ci-workflow-shape.test.ts`, `packages/testing/src/cdp-e2e-session.ts` + tests |

## Findings → fix

| # | Sev | Where | Defect | Fix | Test |
|---|---|---|---|---|---|
| K1 | High | `packages/cli/src/root-env.ts:59`; `dispatch.ts:128` | `x --cwd <app>` never loads the app's `.env*`: skip compares app root with the `--cwd`-resolved cwd, but Bun loaded the **process** cwd's `.env`. Proven: `--cwd app2 env check` → `X_ENV_MISSING` | Pass both cwds; compare `root.dir` with the process cwd | `root-env.test.ts` `{ cwd: root, processCwd: elsewhere }` returns root vars |
| K2 | Low | `packages/cli/src/root-env.ts:33` (`parseDotenv`) | Disagrees with Bun: multi-line `"…"` PEM → first line + quote; backtick quoting kept literally | Accumulate until closing quote; accept backticks | `root-env.test.ts` PEM + backtick parity with `Bun.env` |
| K3 | Medium | `packages/cli/src/runtime-render.ts:487` | `isr` runs `load` (DB) on **every** hit before mode choice — ISR costs SSR. Proven: 5 GETs → 5 loads, 1 store entry | Resolve `load` (and `takeRedirect`) inside the `isr.serve(...)` producer | `runtime-render-isr.test.ts` "an isr hit does not run load" |
| K4 | Medium | `packages/cli/src/dev-route-table.ts:126-130`; `cmd-dev.ts:246` | `x dev` drops `runtime.images` (container passes it, `serve-web.ts:117`) → `/media` differs dev vs prod | `images?: ImageTransformDriver` on `DevRouteTableInput`, pass `appRuntime?.images` | `dev-route-table.test.ts` "the app's runtime images driver reaches /media" |
| K5 | Low | `packages/cli/src/dev-traces.ts:142-158` | Idle background roles mint traces that evict real requests from `/_x/timeline` in ~2 min. Proven | Drop a trace whose first span is not an HTTP root (`isHttpRoot`) when its parent is absent | `dev-traces.test.ts` "background traces do not evict request traces" |
| K6 | Low | `packages/cli/src/island-harness-route.ts:48-54` | `/_x/island` lacks the loopback Host check (`X_DEV_HOST_REFUSED`, only `dev-dashboard.ts:250,258`) → DNS-rebinding read | Call `hostRefusal(request, devUrl)` first; thread `devUrl` into `HarnessRouteInput` | `island-harness-route.test.ts` non-loopback Host → 421 |
| K7 | Low | `packages/cli/src/cmd-dev.ts:404`; `dev-supervisor.ts:196` | `process.stdout/stderr.write` against `packages/cli/CLAUDE.md` | `writeLine` / `writeErrorLine`; add a `scripts/` or biome restricted-globals rule for `process.stdout.write` in `packages/cli/src` | `cmd-dev.test.ts` onReload through `writeLine` |
| K8 | Low | `packages/cli/src/island-store.ts:141-201` | Prebuilt island store never checks island sources → stale chunk served after edit + `apps/web/server.ts` boot. *low confidence on reach* | Record source-graph identity per chunk, rehash at read; or dev path ignores the store | `island-store.test.ts` "an edited island source is stale" |
| K9 | Medium | `packages/cli/src/cmd-jobs.ts:140-151`, `cmd-jobs-spec.ts:15,26`; `wiki/CLI-Reference.md:46,1085` | `x jobs drain` documented shipped, but `redis`/`nats` targets throw on every method → leases prod jobs 5 min, fails, nacks | Move `drain` to `PLANNED_SUBCOMMANDS` (`cmd-planned.ts`) until a durable second driver ships (owner row 5); wiki row → planned | `cmd-jobs.test.ts` "drain --to redis refuses before leasing" |
| K10 | Low | `packages/cli/src/cmd-mcp.ts:39-41,166-170` | `host.close()` only on success → PGlite dir held on throw | `try/finally` (pattern `:122-127`) | `cmd-mcp.test.ts` "a stdio session that throws still closes the host" |
| K11 | Medium | `packages/admin/src/form-decode.ts:72-75` (`numberOf`) | Bare `Number(raw)`: `0x10` → money `minor: 16`; `' '` → `0` not `null` (phantom audit diff). Proven | Export `DECIMAL` (or `numeric()`) from `packages/schema/src/coerce.ts:14-25`; trim; whitespace-only → `blank(field)`; non-decimal passes as string for the schema to refuse | `form-decode.test.ts` "a hex or whitespace number is not converted" |
| K12 | Low | `packages/cli/src/bin.ts:26-33` | Hand-off `Bun.spawn` forwards no SIGTERM/SIGINT/SIGHUP | Forward the three; exit with the child's code | `bin.test.ts` signal reaches child |
| K13 | Low | `packages/cli/src/cmd-new.ts:216-222`, `messages.ts:176` | `x new --dry-run` says "created …" with `${app.kebab}/` paths | New `cli.new.dryRun` message "would create", target paths | `cmd-new.test.ts` dry-run wording |
| K14 | Low | `packages/cli/src/dev-lock.ts:259-266,333-349` | `openSync(path,'wx')` then separate write → concurrent preflight reads `null`, unlinks the live claim | Write temp file, `linkSync` into place | `dev-lock.test.ts` racing claimers, one wins |
| K15 | Medium | `.github/workflows/ci.yml:768-780` (`deploy-proof`) | Path filter diffs against `github.event.before` only → a red proof on A is hidden by B; `release.yml` then publishes from B | Diff against the head SHA of the last **successful** `deploy-proof` on main (`gh api …/runs?branch=main&status=success`), or always run on `release:`-subject commits; extract the decision to a `scripts/` helper | helper unit test: red predecessor forces `run=true` |
| K16 | Low | `packages/cli/src/import-scan.ts:50`, `scripts/boundaries.ts:82` | `typeof import('@ultimat3/cli')` bypasses the tier rule (0 violations). Proven | Collect type-position `import('…')` with the shared mask (or `ts-scan.ts`) | `boundaries.test.ts` → `X_BOUNDARY_VIOLATION` |
| K17 | Low | `scripts/node-imports.ts:51`; `biome.json` | Bare `'fs'` / `require('child_process')` skip the `why:` guard; biome `useNodejsImportProtocol` is info only | `"style": { "useNodejsImportProtocol": "error" }` in `biome.json` | `node-imports.test.ts` bare `'fs'` → site; `bun run lint` red on a probe |
| K18 | Medium | `packages/cli/src/templates/guard-unzoned-date.ts:29,75` (shipped app guard) | `includes('timeZone')` matches `timeZoneName`; `.toDateString()` / `.toTimeString()` not in `FORMATTER`. Proven: 0 findings each | `/\btimeZone\s*:/`; add `\.to(?:Date|Time)String\s*\(` | emitted `guards/unzoned-date.test.ts`; apps' copies byte-equal (`scaffold-guards-style.test.ts`) |
| K19 | Low | `packages/cli/src/templates/guard-bare-error.ts:33`; `scripts/test-bare-error.ts:43` | `throw Error('x')` (no `new`) and `EvalError`/`ReferenceError`/`URIError`/`AggregateError` slip | `/\bthrow\s+(?:new\s+)?(Error\|TypeError\|RangeError\|SyntaxError\|ReferenceError\|EvalError\|URIError\|AggregateError)\s*\(/g` in both | both guards' tests |

## Open issues in this sweep

| Issue | Fix | Test |
|---|---|---|
| **#444** `x shot` viewport | `viewport` flag (`390x844,1440x900`) in `cmd-shot-spec.ts:12-79`; pure `parseViewports()` in new `shot-viewport.ts`; route capture once per viewport into `<out>/<w>x<h>/`; parsed list replaces `MATRIX_VIEWPORTS` (`cmd-shot-matrix.ts:25-28`); refuse with `--island`; `X_CLI_BAD_FLAG`; `wiki/CLI-Reference.md:1225` | `shot-viewport.test.ts`, `cmd-shot-matrix.test.ts` |
| **#572** offline e2e flake | `offline(enabled)` (`packages/testing/src/cdp-e2e-session.ts:150-170`) confirms: poll `navigator.onLine === !enabled` in every page session, bounded, `CdpTimeoutError` | `cdp-e2e-session.test.ts` fake connection |
| **#519** TLS replication live test never runs | `postgres-tls` service (`postgres:17-alpine`, `wal_level=logical`, `ssl=on`, port 5440; certs from a digest-pinned one-shot init into gitignored `docker/.tls/`, recipe `realtime/src/pg-tls.live.test.ts:5-18`); `TEST_TLS_REPLICATION_URL`, `TEST_TLS_ROOT_CERT` in `docker/test-services.env`; `live` part `ci.yml:139-141`; port in `ci-workflow-shape.test.ts` | the `.live` suite runs in CI |
| **#518** FULL on keyed `subscribes:` | O-518 default: stop adding keyed `subscribes:` tables at `cli/src/db-subscribes.ts:80-86` (keep `paramsChannelTables()`); match `schema-diff.ts:197`; reword `wiki/Error-Codes.md:209-210` | `db-subscribes.test.ts`, `schema-diff.test.ts`; `realtime/src/pg-identity-window.live.test.ts` stays green |
| **#513** CDP timeout tracker | O-513: close as instrumented | — |
| **#491** settings page | O-491: close wontfix (axiom 8) | — |

## Steps
1. Branch `fix/sweep-6-cli-ci`; brief A–D. Guard changes (C) must keep the tracked apps' `guards/` copies byte-equal — coordinator regenerates via the scaffold path, not by hand.
2. `bun run verify`; `bun run scripts/reference-app-gate.ts`; PR `Fixes #444 #572 #519 #518`, close #513 #491 with the decision link.

## Done when
- K1–K19 pinned; four issues closed by the PR; two closed by decision.
