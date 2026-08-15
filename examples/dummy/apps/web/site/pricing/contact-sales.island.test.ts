import { expect, unitTest } from '@ultimat3/testing';
import * as entry from './contact-sales.island';

// The runtime boots an island by calling `mount` on whatever the module exports. A renamed or
// deleted export is a page that renders, serves, passes every other gate and does nothing when
// clicked — which is exactly the failure nothing else in the build can see.
unitTest('contact-sales.island exports the mount the hydration runtime calls', () => {
  expect(typeof entry.mount).toBe('function');
});
