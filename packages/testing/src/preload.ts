// The bunfig preload for apps: frozen clock, seeded RNG, sealed network, custom matchers, and
// the framework's fixture bag. Loaded once per test process, before any test file — an app never
// has to remember to call it.
//
//   [test]
//   preload = ["@ultimat3/testing/preload"]

import { installDeterminism } from './determinism';
import { registerFrameworkFixtures } from './framework-fixtures';
import './matchers';
import { onFileBoundary } from './file-boundary';
import { disposeLiveIslands } from './fixture-island';
import { releasePluginsAfterIsolatedFile } from './isolated-plugins';
import { installRegistryLeakGuard } from './registry-leak-guard';
import { sealNetwork } from './sealed-network';

const seed = Number.parseInt(Bun.env['ULTIMATE_TEST_SEED'] ?? '', 10);
const now = Bun.env['ULTIMATE_TEST_NOW'];

installDeterminism({
  ...(Number.isFinite(seed) ? { seed } : {}),
  ...(now === undefined ? {} : { now }),
});

registerFrameworkFixtures();

// One `bun test` invocation is one process: a file that leaves a process-global registry dirty
// fails a later file in another package, for a reason nothing in that file explains.
installRegistryLeakGuard();

// A worker runs many files in one global unless the repo opted into `--isolate` (22.7): a mount a
// file never disposed is disposed between files, and `file-boundary.ts` then puts `globalThis`
// back to what the first file saw.
onFileBoundary(disposeLiveIslands);

// Isolated runs only (`x test` says so): Bun 1.4.0 keeps every finished file alive while a plugin
// is registered. See `isolated-plugins.ts`.
releasePluginsAfterIsolatedFile();

// Opt-out exists for one case: a test that deliberately exercises a real integration in a job the
// team runs on purpose. It is an env var, not an API, so it cannot be set from inside a test file.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();
