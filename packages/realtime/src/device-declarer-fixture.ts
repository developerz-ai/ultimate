// A second declaring module for the generation test, declaring at its top level as an app module
// does: imported (once) after the test's own file holds the path, in a later generation.

import { deviceSocket } from './device-socket';

export const elsewhere = deviceSocket({
  path: '/gen-taken',
  resolveToken: () => null,
  onFrame: () => undefined,
});
