// The bunfig preload for apps: frozen clock, seeded RNG, sealed network, custom matchers. Loaded
// once per test process, before any test file — an app never has to remember to call it.
//
//   [test]
//   preload = ["@ultimat3/testing/preload"]

import { installDeterminism } from './determinism';
import './matchers';
import { sealNetwork } from './sealed-network';

const seed = Number.parseInt(Bun.env['ULTIMATE_TEST_SEED'] ?? '', 10);
const now = Bun.env['ULTIMATE_TEST_NOW'];

installDeterminism({
  ...(Number.isFinite(seed) ? { seed } : {}),
  ...(now === undefined ? {} : { now }),
});

// Opt-out exists for one case: a test that deliberately exercises a real integration in a job the
// team runs on purpose. It is an env var, not an API, so it cannot be set from inside a test file.
if (Bun.env['ULTIMATE_TEST_ALLOW_NET'] !== '1') sealNetwork();
