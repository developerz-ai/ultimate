# @ultimat3/testing — the e2e driver's files (moved out of `packages/testing/CLAUDE.md`, 2026-11-09)

Moved verbatim to keep the package's `CLAUDE.md` under its 24 KB ceiling
(`bun run scripts/claude-md-size.ts`). The file names are still the source of truth: `ls
packages/testing/src/cdp-* packages/testing/src/e2e-*`.

## The browser-backed e2e driver (moved here from `@ultimat3/cli` in 22.0.0)

Raw CDP: `@ultimat3/core` and Bun, nothing else; `cli` imports it over `cli -> testing`. Full rule: `docs/history/testing.md`.

| File | Job |
|---|---|
| `e2e-driver.ts` | `installE2eDriver({ page, baseUrl })` — the ONE call an app's test preload makes. Registers `page` over its declaration and installs the `e2eTest` seam; returns the undo |
| `e2e-page.ts` | `PageLike` over four members of `ScrapePage`, declared structurally so a test stands one up in six lines |
| `e2e-locator.ts` | `LocatorLike` — a handle that resolves nothing until asked, one round trip per question |
| `e2e-selection.ts` | what a locator SELECTS, as data, and the one in-page expression that resolves it |
| `e2e-evaluate.ts` | the closure→string crossing, which is the only lossy edge in the adapter |
| `e2e-errors.ts` | one constructor per refusal |
| `e2e-dom-fixture.ts` | a document small enough to hold in a test and real enough to RUN the expressions above |
| `cdp-browser.ts` | the two doors: `openE2eBrowserIfAvailable()` (undefined when there is no browser) and `openE2eBrowser()` (refuses by name), and the close that undoes both halves |
| `cdp-launch.ts` | which Chrome, its flags, the launch deadline (`LAUNCH_TIMEOUT_MS`, 60 s — a cold start is not a call) and the ONE relaunch (`LAUNCH_ATTEMPTS`) |
| `cdp-launch-probe.ts` | `startsChrome`: `--version` under a deadline; skipped on `win32` (never exits) |
| `cdp-launch-attempt.ts` | one start in its own group; on no answer a full reap (group, then profile + singleton dir: `cdp-launch-profile.ts`). ONE awaited `close()` |
| `cdp-connection.ts` | CDP over a transport — the launched Chrome's pipe (`cdp-pipe.ts`), a remote one's `WebSocket` (`cdpConnect`): reply correlation by `id`, event waiters, the per-call deadline; why one went unanswered is `cdp-wire-watch.ts` |
| `cdp-e2e-session.ts` | the BROWSER half, `E2eSession`: every target PAUSED until its Network domain is on |
| `cdp-e2e-page.ts` | one TAB, `E2eTab`: `E2eBrowserPage`'s six methods (`accessibilityTree` required) plus `reload`, `waitFor`, `indexedDbNames`, `close`. `offline()` forwards to the session — the switch is browser-wide |
| `e2e-app.ts` | `startE2eApp({ root, mode, seed })`: a THROWAWAY `ULTIMATE_STATE_DIR`, `/readyz`-gated; `stop()` removes it. Full rule: `docs/history/testing.md` |
| `failure-context.ts` | a FAILED test's message ends with the e2e app's last 40 log lines (≤ 4 kB): `e2e-run.ts` installs `app.log()`, `fixtureTest` and `e2eTest` append it. Never on a pass |
| `e2e-preload.ts` + `e2e-browser-handle.ts` | the `e2e` step's preload (`@ultimat3/testing/e2e-preload`): with `ULTIMATE_E2E_ROOT` set it spawns the app, opens ONE browser, installs its first tab, and publishes `e2eBrowser()`, `e2eApp()`, `e2eBaseUrl()` |
| `packages/cli/src/verify-e2e.ts` | `withE2eApp` (cli's): in an app on a machine with Chrome, the `e2e` step runs the suite with that preload; otherwise exactly as before |
| `cdp-errors.ts` | one constructor per way the browser half refuses |

