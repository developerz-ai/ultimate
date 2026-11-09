// The bunfig preload for apps: frozen clock, seeded RNG, sealed network, custom matchers, and
// the framework's fixture bag. Loaded once per test process, before any test file — an app never
// has to remember to call it.
//
//   [test]
//   preload = ["@ultimat3/testing/preload"]

// A green run prints the reporter and nothing else: the process logger's lines go to a sink.
import './quiet-logs';
import { captureDeterminism, installDeterminism, restoreCapturedDeterminism } from './determinism';
import { registerFrameworkFixtures } from './framework-fixtures';
import './matchers';
import { installTabA11yAudit } from './e2e-a11y-tabs';
import { onFileBoundary } from './file-boundary';
import { ISOLATED_ENV, releasePluginsAfterIsolatedFile } from './isolated-plugins';
import { installModuleMockBoundary } from './module-mock-boundary';
import { installPerTestReset } from './per-test-reset';
import { installRegistryLeakGuard } from './registry-leak-guard';
import { sealNetwork } from './sealed-network';
import { installTestSealKey } from './test-seal-key';

// `.secrets.key` is gitignored and CI names no `ULTIMATE_SECRETS_KEY`: without a key every test
// over a `.sealed()` column is `X_SEAL_KEY_MISSING` on a fresh clone. A throwaway one, only in a
// test process (`NODE_ENV=test`) and only when the app supplied none — see the file.
installTestSealKey();

const seed = Number.parseInt(Bun.env['ULTIMATE_TEST_SEED'] ?? '', 10);
const now = Bun.env['ULTIMATE_TEST_NOW'];

installDeterminism({
  ...(Number.isFinite(seed) ? { seed } : {}),
  ...(now === undefined ? {} : { now }),
});

registerFrameworkFixtures();

// And the CLOCK, per FILE: the frozen instant is one process', so a file that advanced it and never
// put it back handed every later file on the worker a moved clock (`clock-file-boundary.test.ts`).
const installedClock = captureDeterminism();
onFileBoundary(() => restoreCapturedDeterminism(installedClock));

// Inside a test process the machine's test slots are already accounted for — by the `x test` /
// `x verify` that spawned it, or by nobody when `bun test` ran bare. An `x test` a test runs in
// process (the framework's own suites do) must never lease from the real pool: it would wait on
// its own parent's slots. `@ultimat3/cli`'s `test-slots.ts` reads this.
Bun.env['ULTIMATE_TEST_SLOT_HELD'] ??= '1';

// One `bun test` invocation is one process: a file that leaves a process-global registry dirty
// fails a later file in another package, for a reason nothing in that file explains.
installRegistryLeakGuard();

// And per TEST: the jobs event bus stores what it is handed, so one test's published answer
// resumed the next test's waiting run (`per-test-reset.ts`).
installPerTestReset();

// And every `mock.module`: Bun keeps one past `mock.restore()` and past the file, so the next file
// on a shared worker read the fake. Put back at the boundary (`module-mock-boundary.ts`).
installModuleMockBoundary();

// And every browser tab a suite drives itself is audited like an `e2eTest`'s page: its findings
// fail the test from this one `afterEach`, so no suite has a line to forget (`e2e-a11y-tabs.ts`).
installTabA11yAudit();

// A shared worker only (an isolated file is a fresh registry anyway): the app's
// `defineApi({ pathStyle })` evaluates once per worker, in whichever file first imports it, and
// must not be refused because an EARLIER file derived action paths under the default style.
//
// And the rate-limit store every declared `rateLimit:` spends from: a file that spent a test
// actor's bucket left it spent for the next file on the worker, so a "the 31st call is a 429" test
// was red whenever another file calling that action ran first. Each file starts with full buckets,
// the store back to one process' memory, as a file run alone would have it.
//
// And the METER store, for the same reason one period longer: a file that drew a seeded org's
// daily allowance left it drawn, so the next file's "the 101st draft is refused" test was red or
// green by file order (`meter-file-boundary.test.ts`).
//
// And the LIFECYCLE, which is one process' too: a drain is terminal, so a file that drained the
// process — or that emitted a real SIGINT at it, as a signal test does — left every later file on
// the worker answering 503 X_DRAINING for a reason nothing in that file explains. Each file starts
// from a live lifecycle, as a file run alone would have it.
if (Bun.env[ISOLATED_ENV] !== '1') {
  const { forgetHandedOutActionPaths } = await import('@ultimat3/action');
  onFileBoundary(forgetHandedOutActionPaths);
  // The meter store's reset is its port's, on the `./adapter` subpath (slice 21).
  const { resetMeterStore } = await import('@ultimat3/action/adapter');
  onFileBoundary(resetMeterStore);
  const { resetRateLimitStore } = await import('@ultimat3/http/adapter');
  onFileBoundary(resetRateLimitStore);
  const { resetLifecycle } = await import('@ultimat3/core');
  onFileBoundary(resetLifecycle);
}

// Isolated runs only (`x test` says so): Bun keeps every finished file alive while a plugin is
// registered. See `isolated-plugins.ts`.
//
// BEFORE the loader install below, and that order is the fix: registering the release first lets it
// clear the loader's handler at the first file's boundary, where the module graph it retains is
// released with it. Installed the other way round, the release still fires but the graph the loader
// already built is what is held, and every finished file stays resident — measured on Bun 1.4.0,
// 8 files, 1 -> 8 live global objects (this file's own leak fixture).
releasePluginsAfterIsolatedFile();

// Every `.tsx` compiles with the framework's JSX factory from the first file on, in every test
// process — an app root or any workspace below it. Bun's own compile of a `.tsx` is wrong on every
// Bun (`@ultimat3/render`'s `module-loader.ts`): through 1.4.2 a cached `React.createElement`
// (`React is not defined`, 18 of one adopter's tests), from 1.4.3 a link-time `SyntaxError: Export
// named 'jsxDEV' not found` in any file that merely imports a component (issue #883). It was
// installed only where `app.config.ts` sat beside the run, so a workspace package's own tests
// needed a hand-written preload (one adopter, and another).
const { installRenderLoader } = await import('@ultimat3/render/server');
installRenderLoader();

// Opt-out exists for one case: a test that deliberately exercises a real integration in a job the
// team runs on purpose. It is an env var, not an API, so it cannot be set from inside a test file.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();
