// The hydration entry point, pinned by name: the runtime boots the island by calling `mount`.
import { expect, unitTest } from '@ultimat3/testing';
import * as entry from './search.island';

unitTest('search.island exports the mount the hydration runtime calls', () => {
  expect(typeof entry.mount).toBe('function');
});
