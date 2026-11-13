// unit — the thread is registered as subscribable at boot. What a subscriber receives, through the
// descriptor and through a real sync node, is the `live` step's: `live/live-thread.live.test.ts`.

import { expect, unitTest } from '@ultimat3/testing';
import { liveThread } from './live/live-thread';

// Named here because a descriptor needs a stable name and this file does not boot the app.
const target = liveThread.named('liveThread');

unitTest('the read is declared live, so it is registered as subscribable at boot', () => {
  expect(target.isLive).toBe(true);
  expect(target.describe().live).toBe(true);
});
