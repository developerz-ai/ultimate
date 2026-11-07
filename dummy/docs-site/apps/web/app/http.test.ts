// The declaration reached the registry. `configureHttp()` is a module-scope side effect, so the
// only thing that can go wrong is nobody importing the module — which is exactly how a shipped app
// rendered every string as ⟦key⟧ for a whole release (issue #249), one seam along.
import { configuredHttp, resetHttpConfig } from '@ultimat3/http';
import { afterAll, expect, unitTest } from '@ultimat3/testing';
import './http';

// Read ONCE, at module scope: every case asserts on what the import registered, in any order.
const declared = configuredHttp();

unitTest('importing the module IS the registration', () => {
  // The list is empty on a fresh scaffold and that is the shipped default; what is asserted is
  // that the KEY reaches the boot, so adding an origin to it takes effect.
  expect(declared?.cors?.origins).toEqual([]);
});

unitTest('the boot-owned keys are absent — the boot measures them, an app can only guess', () => {
  expect(declared).toBeDefined();
  for (const key of ['port', 'hostname', 'dev', 'buildId', 'signInPath']) {
    expect({ key, declared: Object.hasOwn(declared ?? {}, key) }).toEqual({ key, declared: false });
  }
});

// The registration is process-global, so a suite that left it set would hand the next file this
// app's config. `resetHttpConfig()` is the seam, and this is the one place it is called — after
// the cases, so none of them depends on running before it.
afterAll(() => {
  resetHttpConfig();
  expect(configuredHttp()).toBeUndefined();
});
