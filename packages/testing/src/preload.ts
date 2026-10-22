// The bunfig preload for apps: frozen clock, seeded RNG, sealed network, custom matchers, and
// the framework's fixture bag. Loaded once per test process, before any test file — an app never
// has to remember to call it.
//
//   [test]
//   preload = ["@ultimat3/testing/preload"]

// A green run prints the reporter and nothing else: the process logger's lines go to a sink.
import './quiet-logs';
import { installDeterminism } from './determinism';
import { registerFrameworkFixtures } from './framework-fixtures';
import './matchers';
import { installAppJsxLoader } from './app-jsx-loader';
import { onFileBoundary } from './file-boundary';
import { ISOLATED_ENV, releasePluginsAfterIsolatedFile } from './isolated-plugins';
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

// A shared worker only (an isolated file is a fresh registry anyway): the app's
// `defineApi({ pathStyle })` evaluates once per worker, in whichever file first imports it, and
// must not be refused because an EARLIER file derived action paths under the default style.
//
// And the rate-limit store every declared `rateLimit:` spends from: a file that spent a test
// actor's bucket left it spent for the next file on the worker, so a "the 31st call is a 429" test
// was red whenever another file calling that action ran first. Each file starts with full buckets,
// the store back to one process' memory, as a file run alone would have it.
if (Bun.env[ISOLATED_ENV] !== '1') {
  const { forgetHandedOutActionPaths } = await import('@ultimat3/action');
  onFileBoundary(forgetHandedOutActionPaths);
  const { resetRateLimitStore } = await import('@ultimat3/http');
  onFileBoundary(resetRateLimitStore);
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

// An app's `.tsx` compiles with the app's JSX factory on the first file, never cached classic.
await installAppJsxLoader();

// Opt-out exists for one case: a test that deliberately exercises a real integration in a job the
// team runs on purpose. It is an env var, not an API, so it cannot be set from inside a test file.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();
