# 31 — The file boundary undoes `mock.module`

> Part of [`overview.md`](overview.md). Depends on: none. Tier: 5 (`testing`).

## Why
Since 22.7 `x test` runs a worker without `--isolate`, and `testing/src/file-boundary.ts:1` promises "the process it would have had alone". It restores globals, env and registries. It does not restore a module mock, and Bun's survives both `mock.restore()` and the file. Reproduced 2026-11-02 under the framework's preload, Bun 1.4.4, three files, `a` mocks a module:

`bun test --no-isolate a b c → b saw FAKE, c saw FAKE, 1 pass 2 fail` · `--isolate → b saw real, 2 pass 0 fail`

The verdict of `b` depends on which worker ran `a` first. That is the order flake the page says cannot happen.
| Adopter | What it cost |
|---|---|
| A | a 20-line per-file wrapper, used in 6 test files, and its own 51-line guard refusing raw `mock.module` |
| B | 2 test files still call it raw; a third's header says it "leaked into the rest of the worker's test files", so that file was rewritten to avoid it |
| C (not on the framework) | 12 test files, and part of an 815-line differential guard exists to tell this leak apart from another |

## Decisions
| Candidate | Outcome |
|---|---|
| Public `mockModule(url, fake)` plus a guard | **killed.** A second spelling beside Bun's, and a convention to enforce. Probe: `mock.module` is `writable: true`, so the preload wraps it and raw use is simply safe |
| `x test --randomize` to surface order flakes | **killed.** `x test unit -- --randomize --seed=7 --rerun-each=30` passes through today. A docs row (below) |
| Retry, quarantine, known-flakes file (one adopter 191 + `flakes: []`, one 61-line rerun, one tag on 11 lines of a non-framework app) | **killed.** `wiki/Testing.md:813` rules it out. `{ retry: 3 }` does pass under Bun, and no adopter's test uses it, so no guard either. Comes back on the first real use |
| Banning `mock.module` in app tests | **killed.** Business of the app; the framework's own ban (`scraping/src/cdp-fake-fixture.ts:4`) stands for its own reason |

## Files to change
- `packages/testing/src/module-mock-boundary.ts` (new, under 60 LOC) — wrap and restore.
- `packages/testing/src/preload.ts:13-18,47` — install it beside `installPerTestReset()`.
- `packages/testing/src/errors.ts:10` — the code, via `bun run new-error-code`.
- `packages/testing/README.md`, `packages/testing/CLAUDE.md`.
- `wiki/Testing.md:615` (the "No per-file isolation" bullet) — names module mocks in what is handed back. `wiki/Testing.md:813` (Rules) — one row: "hunting a flake: `x test unit --filter <file> -- --rerun-each=30 --randomize`". `wiki/Error-Codes.md`.

## Steps
1. Replace `mock.module` on the `bun:test` object with a wrapper. It resolves a relative specifier against the caller's directory (from the stack, `Bun.resolveSync`), and on the first mock of a URL in this file copies the real namespace with `{ ...require(url) }`, then calls the original.
2. `onFileBoundary`: for every URL recorded, `original(url, () => real)`, then forget them. Order matches `testing/src/file-boundary.ts`: hooks before globals, so a mock's teardown still sees its fake DOM.
3. A real module that throws on first load: record nothing, mock it, and at the boundary raise the code naming the file, because nothing can be restored and the next file would inherit it silently. Refusing at the mock itself would break the common reason to mock (a module that cannot load here).
4. Under `--isolate` the hook still runs and costs a map read; `ISOLATED_ENV` needs no branch.
5. Note in `packages/testing/CLAUDE.md`: loading the real module first means its top-level side effects run. Same trade the adopter's wrapper already pays in 6 files.

## Error codes
| Code | When | Fix |
|---|---|---|
| `X_TEST_MODULE_MOCK_UNRESTORABLE` | a mocked module's real source threw when loaded for its snapshot, so a later file in this worker would see the fake | `x test --isolate`, or inject the seam rather than mocking the module. Tier 5 takes neither status flag |

## Tests
- `packages/testing/src/module-mock-boundary.test.ts` (unit): spawns `bun test --no-isolate a.test.ts b.test.ts` over a temp fixture under the preload, as `fixture-island-cleanup.test.ts` does, and asserts `b` saw the real value through a shared consumer. Fails on today's code by the probe above.
- Same fixture: a relative specifier resolves against the mocking file, not the cwd; a bare `mock.restore()` does not touch the record; a throwing module raises the code in the next file's boundary.
- Mutation: delete the boundary hook, the spawn test goes red.
- `bun test packages/testing/src/module-mock-boundary.test.ts`.

## Semver
Breaking by the plan rule (a new red verdict). A later test that passed only because it inherited another file's fake now sees the real module, which is the bug. Upgrading row: "a test that goes red here was reading another file's `mock.module`; mock it in the file that needs it."

## Done when
- The probe prints `b saw real` under `--no-isolate`.
- `examples/dummy` and `dummy/social-media-clone` pass unchanged: `bun run scripts/reference-app-gate.ts` green.
- `bun run verify` green.
