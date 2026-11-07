// A live cursor's epoch is the build the process says it is: core's `APP_VERSION`, the one key a
// deploy sets. It read `X_BUILD_ID`, which nothing sets, so every build shared the epoch `dev` and
// a reconnect after a deploy resumed against rows the new build never served.

import { afterEach, expect, test } from 'bun:test';
import { liveEpoch } from './live';

const before = Bun.env['APP_VERSION'];
afterEach(() => {
  if (before === undefined) delete Bun.env['APP_VERSION'];
  else Bun.env['APP_VERSION'] = before;
});

test('the epoch is APP_VERSION, and dev when no build is named', () => {
  Bun.env['APP_VERSION'] = 'build-42';
  expect(liveEpoch()).toBe('build-42');
  delete Bun.env['APP_VERSION'];
  expect(liveEpoch()).toBe('dev');
});
