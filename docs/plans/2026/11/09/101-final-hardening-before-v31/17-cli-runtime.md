# 17 — cli runtime and scaffold: what production logs and adopters exposed

> Part of [`overview.md`](overview.md). Depends on: [`02`](02-core-schema.md) (Sentry hooks). Tier: 5 (`cli`). Port wiring (`RuntimeOverrides`) is [`21`](21-adapter-wiring.md); storage runtime files belong to [`04`](04-storage.md).

## Findings
| # | Sev | Site | Failure | Fix |
|---|---|---|---|---|
| C1 | Med | `cli/src/error-catalog.ts:137-139` (`importAll`) | loads `@ultimat3/admin` and `@ultimat3/ui` (`.tsx`) without the Solid loader: `SyntaxError: Export named 'jsxDEV' not found`. `x errors list --json` exits 1; `x errors explain X_ADMIN_INVALID` answers `X_ERROR_CODE_UNKNOWN` though the wiki documents it. The test preload (`scripts/test-setup.ts:57-61`) masks it | `installRenderLoader()` (`render/src/module-loader.ts:308`) before the imports |
| C2 | Low | `cli/src/write-line.ts:90-96` (`writeAll`) | `EPIPE` rethrown: `x errors list --json \| head -c 10` crashes with a stack trace, exit 1 | treat `EPIPE` as reader gone: stop writing, keep the command's own exit code |
| C3 | Med (prod) | `cli/src/templates/scaffold-repo.ts:215`; `runtime-jobs.ts:83-97`; `jobs/src/worker-registry.ts:124-136` | scaffold sets `jobs.queues: ['<app>-default']`, `job()` defaults to `default`: every deployed app polls an unused queue and logs `jobs.worker.queue-unregistered` on every boot (seen on both production apps) | scaffold `['default']`; the worker refuses at boot (coded) a configured queue no job targets, with the fix naming the config line |
| C4 | Med | `cli/src/serve-env.ts:112-137` | boot chains a bare DSN Sentry reporter beside an app-installed one: an app with its own scrubbing reporter and `SENTRY_DSN` set reports twice, once unscrubbed | with [`02`](02-core-schema.md) K5 hooks, the boot builds the one Sentry reporter from env + the app's hook config; an app-installed Sentry-family reporter replaces it, never chains (v31-break) |
| C5 | Med (adopter-found) | `cli/src/runtime-admin.ts:133-136` (`adminMountRoutes`) | admin mounted at `base` and `${base}/*rest` only: `/en/admin/jobs` is a 404 in a locale-routed app; an adopter keeps a hand list | mount under each routed locale prefix too |
| C6 | Low | `x new` | writes no `.github/dependabot.yml`; adopters' Dependabot bumped single `@ultimat3/*` packages and broke lockstep | `templates/scaffold-dependabot.ts`: group `ultimate: ['@ultimat3/*', 'create-ultimate']`, all update types; plus `docker` for pinned images |
| C7 | Low (tests) | `cli/src/serve-web.ts` (228), `runtime-isr.ts`, `runtime-assets-site-cache.ts` | no direct test | add one each |
| C8 | Low (noise) | runtime boot | `X_IMAGE_NOT_PREBUILT` logged at error in a test boot | warn in dev/test, error only in a production build |
| C9 | Med (upgrade friction) | `cli/src/verify-exercise.ts` | an adopter's 30.0 upgrade spent ~15 commits only feeding `x exercise` (seeding, per-call state); another went red six times | `x g` generators emit the exercise seed for what they generate; `x upgrade` reports exercise findings as a list with each fix before the gate goes red |

## Files to change
- `packages/cli/src/error-catalog.ts`, `write-line.ts`, `templates/scaffold-repo.ts`, `templates/scaffold-dependabot.ts` (new), `runtime-jobs.ts`, `serve-env.ts`, `runtime-admin.ts`, the image-prebuild log site, generator templates feeding exercise, `upgrade-*.ts` report.
- `packages/jobs/src/worker-registry.ts` (C3 boot refusal; coordinate with [`12`](12-jobs.md) — different sweep).
- `wiki/CLI-Reference.md`, `wiki/Upgrading.md` (C3, C4).

## Tests
- `error-catalog.child.test.ts`: spawn `bin.ts errors explain X_ADMIN_INVALID --json` with no preload → `ok: true`.
- `write-line.test.ts`: injected `EPIPE` → no throw, exit code unchanged.
- `scaffold-repo.test.ts`: queues `['default']`; scaffold-smoke boots with no `queue-unregistered` line.
- `serve-env.test.ts`: app Sentry reporter + `SENTRY_DSN` → one send per error.
- `runtime-admin.test.ts`: `/en/admin/jobs` → 200.
- `bun test packages/cli/src/<file>.test.ts` per file; scaffold-smoke in CI.

## Done when
- A fresh `x new` app deployed with the default config logs no warning at boot.
