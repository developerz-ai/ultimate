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
import { registerFrameworkFixtures } from '../packages/testing/src/framework-fixtures';
import '../packages/testing/src/matchers';
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

// The per-TEST half, the same one an app's preload installs: the jobs event bus STORES what it is
// handed, so an answer one test published would resume the next test's waiting run.
installPerTestReset();

// Opt-out is an env var, not an API, so no test file can quietly unseal the network for itself.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();

// One Chrome per run, not per suite: suites that lease a browser (`leaseE2eBrowser`) share it, and
// only a preload's `afterAll` runs after every file — Bun fires neither `exit` nor `beforeExit`
// under `bun test`. Under `--isolate` it runs after each file, which is also correct.
closeE2eBrowsersAtRunEnd();
