// The bunfig preload for the framework repo itself: frozen clock, seeded RNG, sealed network,
// custom matchers, framework fixtures. Every package's tests run under the same rules the
// framework enforces on the apps it generates — nondeterminism is a bug here too.
//
// Imported by relative path on purpose: a preload runs before anything else, so it must not depend
// on workspace symlinks being installed. Generated apps use `@ultimat3/testing/preload` instead.

import { installDeterminism } from '../packages/testing/src/determinism';
import { registerFrameworkFixtures } from '../packages/testing/src/framework-fixtures';
import '../packages/testing/src/matchers';
import { installRegistryLeakGuard } from '../packages/testing/src/registry-leak-guard';
import { sealNetwork } from '../packages/testing/src/sealed-network';

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

// Opt-out is an env var, not an API, so no test file can quietly unseal the network for itself.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();
