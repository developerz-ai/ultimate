// The bunfig preload for the framework repo itself: frozen clock, seeded RNG, sealed network,
// custom matchers, framework fixtures. Every package's tests run under the same rules the
// framework enforces on the apps it generates — nondeterminism is a bug here too.
//
// Imported by relative path on purpose: a preload runs before anything else, so it must not depend
// on workspace symlinks being installed. Generated apps use `@ultimat3/testing/preload` instead.

// A green run prints the reporter and nothing else: the process logger's lines go to a sink.
import '../packages/testing/src/quiet-logs';
import { closeE2eBrowsersAtRunEnd } from '../packages/testing/src/cdp-browser-lease';
import { installDeterminism } from '../packages/testing/src/determinism';
import { onFileBoundary } from '../packages/testing/src/file-boundary';
import { registerFrameworkFixtures } from '../packages/testing/src/framework-fixtures';
import '../packages/testing/src/matchers';
import { installRenderLoader } from '../packages/render/src/module-loader';
import { releasePluginsAfterIsolatedFile } from '../packages/testing/src/isolated-plugins';
import { installPerTestReset } from '../packages/testing/src/per-test-reset';
import { installRegistryLeakGuard } from '../packages/testing/src/registry-leak-guard';
import { sealNetwork } from '../packages/testing/src/sealed-network';
import { installTestSealKey } from '../packages/testing/src/test-seal-key';

// The same throwaway seal key an app's preload installs: no test over a `.sealed()` column has to
// mint one, and none is `X_SEAL_KEY_MISSING` on a clone with no `.secrets.key`. A test whose
// SUBJECT is the missing key deletes the variable itself and restores it.
installTestSealKey();

const seed = Number.parseInt(Bun.env['ULTIMATE_TEST_SEED'] ?? '', 10);
const now = Bun.env['ULTIMATE_TEST_NOW'];

installDeterminism({
  ...(Number.isFinite(seed) ? { seed } : {}),
  ...(now === undefined ? {} : { now }),
});

registerFrameworkFixtures();

// `bun run test` runs every package in ONE process, so a file that leaves a process-global
// registry dirty fails a later file in another package. The guard names the file that leaked.
installRegistryLeakGuard();

// Isolated runs only (`x test` says so): Bun 1.4.0 keeps every finished file alive while a plugin
// is registered. See `isolated-plugins.ts`.
releasePluginsAfterIsolatedFile();

// Every `.tsx` compiles to the server factory from the first file on, AFTER the release above for
// the reason `@ultimat3/testing/preload` gives. Bun's own compile is wrong on every Bun, and from
// 1.4.3 it is a link-time `SyntaxError: Export named 'jsxDEV' not found` in every file that imports
// a component (issue #883). The same loader an app's preload installs, so a framework suite runs
// its components the way an app does; a suite whose subject is a process WITHOUT it spawns one.
installRenderLoader();

// The per-TEST half, the same one an app's preload installs: the jobs event bus STORES what it is
// handed, so an answer one test published would resume the next test's waiting run.
installPerTestReset();

// The per-FILE half, the same one an app's preload installs: the LIFECYCLE is one process' too, and
// a drain is terminal. A file that drained the process — or that emitted a real SIGINT at it, as a
// signal test does — left every later file on the worker answering 503 X_DRAINING for a reason
// nothing in that file explains. Each file starts from a live lifecycle, as a file run alone would
// have it.
const { resetLifecycle } = await import('@ultimat3/core');
onFileBoundary(resetLifecycle);

// Opt-out is an env var, not an API, so no test file can quietly unseal the network for itself.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();

// One Chrome per run, not per suite: suites that lease a browser (`leaseE2eBrowser`) share it, and
// only a preload's `afterAll` runs after every file — Bun fires neither `exit` nor `beforeExit`
// under `bun test`. Under `--isolate` it runs after each file, which is also correct.
closeE2eBrowsersAtRunEnd();
