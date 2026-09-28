# 06 — cli

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5.

## Files to change
| File | Defect | Verdict |
|---|---|---|
| `packages/cli/src/bin.ts:26-33` | global `x` hands off to the app-local CLI via `Bun.spawn` and forwards no signals → SIGTERM orphans `x dev`, which holds the port + `.x/dev.lock` → next run `X_DEV_ALREADY_RUNNING` | CONFIRMED, med |
| `packages/testing/src/test-types.ts:126-131` | no browser driver → `e2eTest` becomes `test.skip`; e2e step green having run nothing | CONFIRMED, med |
| `packages/cli/src/cmd-new.ts:207,252`, `messages.ts:153` | `cli.new.done` always `cd {name}` even with `--dir`; `--dry-run` prints `name/…` and says "created" | CONFIRMED, low |
| `packages/cli/src/dev-lock.ts` (`claimExclusive`, `preflight`) | `openSync('wx')` creates an empty file before the write; a concurrent boot reads `null`, calls it stale, deletes the live claim → two PGlite writers | PLAUSIBLE, low |

## Steps
1. `bin.ts`: forward `SIGTERM`/`SIGINT`/`SIGHUP` to the child; exit with the child's code.
2. `test-types.ts` + the e2e verify step: when every e2e test in the run skipped for "no driver", fail with a coded error (reuse an existing testing/cli code if one fits; else `bun run new-error-code`). No opt-out flag — one path; CI installs the driver.
3. `cmd-new.ts`: print `cd ${quoteArg(target)}`; dry-run paths are the target path; new message key `cli.new.dryRun` in `packages/i18n/src/catalogs/en.json`.
4. `dev-lock.ts`: write to a temp file then `linkSync` into place (EEXIST keeps exclusivity).

## Tests
- `packages/cli/src/local-cli.test.ts` — spawn test: SIGTERM parent → child gone.
- `packages/testing/src/test-types.test.ts` — all-skipped run refused.
- `packages/cli/src/cmd-new.test.ts` — `--dir /tmp/x` summary names `/tmp/x`; dry run says "would create".
- `packages/cli/src/dev-lock.test.ts` — reader never observes an empty claim.
- `bun test packages/cli/src/<file>.test.ts` per file.

## Not a bug (don't reopen)
- #573/#575 navigation fixes (no regression); `assertRouteNavigation` refusing `'document'` without opt-in; `runVerify` skip handling; `x secrets` name charset; unknown command/flag refusals.

## Done when
- Tests fail on `fcfe31dc`, pass after; CI `scaffold-smoke` still green; `bun run verify` green.
