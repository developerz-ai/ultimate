# 12 — cli

> Part of [`overview.md`](overview.md). Depends on: 02, 07, 08, 09. Tier: 5. Path-disjoint from 11, 13.
> All paths under `packages/cli/src/` unless prefixed.

## Files to change
| Where | Change | Row |
|---|---|---|
| `runtime-render.ts:432`, `serve-web.ts:150`, `cmd-dev.ts:244` | `isr.attach()` where the controller is built; its detach on the boot's stop list | `s2-con #1` (STANDS in `s3-be`: no caller anywhere) |
| `runtime-services.ts:322,323,415` | loaders take `services.root`, as `:368` | `s2-cli #1` |
| `prerender-out.ts:10-25`, `cmd-build.ts:274` | refuse an `out` inside the root that is not under `.x/` or lacks the build's own marker | `s2-cli #2` |
| `prerender.ts:179-180` | load findings fail the build, as `generateAppMigration` (`db-generate.ts:94`) | `s2-cli #5` |
| `test-select.ts:42,61` | repo-only ignores anchored at the root | `s2-cli #4` |
| `gh-target.ts:80-88` | the no-number lookup drops `--repo` or passes the branch | `s2-cli #3` |
| `role-replicator.ts:86-99`, `runtime-services.ts:393` | a `replicator` readiness check over the feed's failure (slice 08 exposes it) | `s2-con #2` |
| `runtime-queue.ts:174`, `framework-schema.ts:151` | framework DDL under `ROLE=migrate` behind `withAdvisoryLock` + `SET LOCAL lock_timeout`; serving roles verify | `s1-con #5` (PLAUSIBLE, `live`) |
| `runtime-queue.ts:209-225`, `runtime-purge.ts` | `resetEventBus()` beside `resetJobsFacade()`; an `x_job_events` purge target | `s2-cli #8`, `s2-ja #4` |
| `role-start.ts:212`, `serve-boot.ts:117` | `drain` applied process-wide; a listener-less role stops claiming at drain start | `s1-con #7` (narrowed in `s3-be`) |
| `runtime-cache.ts:185-190` | the boot subscribe retried | `s1-con #8` |
| `runtime-render.ts:451-467` | the static memo single-flighted | `s1-con` low |
| `dev-dashboard.ts:61-72,225-232` | the SQL panel is POST, same-origin checked; `/_x/*` checks `Host` | `s1-sec M3, L9` |
| `runtime-storage.ts:183-190`, `runtime-assets.ts:70-77` | stored objects served with `Content-Disposition` / a sandbox CSP outside an image allow-list | `s1-sec L6` |
| `cmd-db-backfill.ts:177,211`, `cmd-db.ts:302-309`, `cmd-i18n.ts:203,280` | `ok: findings.length === 0` | `s2-cli #6, #7` |
| `cmd-doctor.ts:304-309`, `cmd-doctor-spec.ts:7,19` | ports through `devPortFor` | `s2-cli #9` |
| `affected.ts:121-143` | an unowned non-doc path is root-wide | `s2-cli #10` |
| `seo-routes.ts:59-70`, `:37-44` | a `/sitemap-:n.xml` route from the same `siteSeo` result; the result memoised | `s2-cli #11`, gaps |
| `mcp-host.ts:266-275`, `cmd-mcp.ts:86-96` | `test.run` folds `errorsIn` and the exit code; a taken port is `X_PORT_IN_USE` (`metrics-endpoint.ts:61,101-118`) | `s2-cli #12, #13` |
| `verify-merge.ts:216-249`, `:103-110` | the union of `shard.files` is duplicate-free and hashes to `corpusHash`; `parsePart` validates `findings` / `durationMs` | `s1-t5 #4`, low |
| `api-registration.ts:52,109` | a binding already bound (or `api` / `defineApi`) is a finding | `s1-t5 #7` |
| `cmd-generate.ts:92-97` | `--dry-run` runs `writeFiles`' planning pass | `s1-t5` low |
| `templates/naming.ts:74-78`, `generate-write.ts:105`, `generate-kinds.ts:183-190`, `templates/resource-service.ts` | a plural, non-ASCII or global-type-shadowing name refused | `s1-t5` low, `s2-cli` lows |
| `templates/scaffold-repo.ts:102` | `solid-js` a named constant, pinned to the root manifest by `scaffold-repo.test.ts` | `s1-t5` low |
| `cmd-help.ts:93-102`, `cmd-jobs.ts:214`, `cmd-verify.ts:153-158`, `cmd-routes.ts` | unknown name → `UnknownCommandError`; id parsed at the door (`readableId`); empty `--only` item uncorrectable; unknown positionals refused | `s1-t5` lows, `s2-arch H2` |
| `dev-lock.ts:227,382`, `jobs-drain.ts:117-122`, `role-start.ts:163-165`, `serve-env.ts:46-63`, `cmd-shot.ts:468,477`, `cmd-build.ts:270-275` | `portPairAfter`; drain pages to exhaustion; own error for `TRUSTED_PROXY_HOPS`; `/^\d+$/` ports; `--out` against the cwd; unusable flag combinations refused | `s2-cli` lows |
| `db-subscribes.ts:1-3` | FULL identity granted to params-channel `records` tables | `s2-rt #11` |
| `source-files.ts:7-19` | `guards/*.ts`, `apps/*/server.ts`, `apps/*/prerender.ts` in `SOURCE_GLOBS` | `s1-t5` gaps |

## Steps
1. ISR attach first — one line per site plus a stop hook. Test: render a tag-only page, `invalidateTags`, expect `x-ultimate-isr: stale` then the new body. Add an `e2e` in `packages/cli/e2e/`. Then close `wiki/Known-Gaps.md:38` (stale: it describes the already-fixed ISR key).
2. State-dir root: the test sets `ULTIMATE_STATE_DIR` outside the root and asserts the declared `realtime`, `jobs`, `cache` config is honoured. This is the cheap fix; the real one is slice 14's single loader.
3. Prerender out: a new refusal code (grep `build-errors.ts` first; else `bun run new-error-code X_BUILD_OUT_UNSAFE --package cli …`). Test on a scratch tree — never on the repo.
4. Boot DDL: `ROLE=migrate` already exists; serving roles call a verify-only path and fail with the existing `FrameworkSchemaFailedError` and a `fix:` naming the migrate role. This changes first-deploy ordering — `docs/ops/` and the Helm migrate job must already run before `web`; confirm in `docker/helm/` and say so in the CHANGELOG.
5. Vacuous greens (`ok: true` beside findings) — sweep every `cmd-*.ts` for the same shape while there: `grep -n "ok: true" packages/cli/src/cmd-*.ts` and check each against its `findings`.

## Tests
- `runtime-render.test.ts`, `runtime-services.test.ts`, `prerender-out.test.ts`, `prerender.test.ts`, `test-select.test.ts`, `gh-target.test.ts` (assert the argv), `role-replicator.test.ts`, `runtime-queue.test.ts`, `runtime-purge.test.ts`, `cmd-db-backfill.test.ts`, `cmd-db.test.ts`, `cmd-i18n.test.ts`, `cmd-doctor.test.ts`, `affected.test.ts`, `verify-merge.test.ts`, `api-registration.test.ts`, `dev-dashboard.test.ts`.
- `live`: `framework-schema.live.test.ts` — two sessions, one holding a transaction open.
- `bun test packages/cli`; `bun run scripts/reference-app-gate.ts`.

## Owned elsewhere
- `bin.ts:27-33` (signals), `cmd-new.ts:221-266`, `dev-lock.ts:261-276` (lock race), e2e all-skipped — 2026-09-28 plan, slice 06.
- 15 config loaders, three CDP drivers, `--worker` vs `--shard` — slice 14.
- Which table `x routes` reads (`s2-arch H2`), generator layout (`s2-arch M1`), guards as copies (`s2-arch H4`) — slice 15.
- Unaudited: every `templates/` generator, `cdp-shot-*`, islands / assets, app projections (`s2-cli`, last table).

## Done when
- A tag bust marks the ISR page stale on every boot path.
- `x build --target static --out apps` refuses. A page that throws at import fails the build.
- A generated resource named `build` or `example` has its tests discovered by `x test` and the gate.
- No `x` command answers `ok: true` with a failure finding.
- `bun run verify` green — the CLI is the gate; run it twice.
