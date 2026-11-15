// The replicator's change handler is its pass: held open on the heartbeat it is handed, so a
// publish that never returns — the pump parked inside `onChange` for good — is a pass a liveness
// route can see, and a quiet feed holds none.

import { describe, expect, test } from 'bun:test';
import { InProcessTransport } from './fanout';
import { changeFeedReplicator } from './replicator';
import { heldBy } from './replicator-heartbeat';
import { change, gatedFeed, NEVER, stubLock, turns } from './replicator-rig-fixture';

const counting = () => {
  const beat = {
    open: 0,
    entered: 0,
    enter: (): (() => void) => {
      beat.open += 1;
      beat.entered += 1;
      let left = false;
      return () => {
        if (left) return;
        left = true;
        beat.open -= 1;
      };
    },
  };
  return beat;
};

describe('unit · replicator heartbeat', () => {
  test('heldBy opens a pass per change and closes it however the handler ends', async () => {
    const beat = counting();
    const ok = heldBy(beat, async () => undefined);
    // The handler's failure is the subject's input, handed over rather than thrown.
    const bad = heldBy(beat, () => Promise.reject(new TypeError('refused')));
    await ok(change(1));
    await expect(bad(change(2))).rejects.toThrow('refused');
    expect(beat).toMatchObject({ open: 0, entered: 2 });
    expect(heldBy(undefined, ok)).toBe(ok);
  });

  test('a publish that never returns holds the pass open; a quiet feed holds none', async () => {
    const beat = counting();
    const transport = new InProcessTransport();
    const feed = gatedFeed();
    const replicator = changeFeedReplicator({
      feed,
      lock: stubLock(),
      transport,
      heartbeat: beat,
    });
    expect(await replicator.start()).toBe(true);
    await turns();
    expect(beat.open).toBe(0);
    transport.publish = () => NEVER;
    void feed.deliver(change(1));
    await turns();
    expect(beat).toMatchObject({ open: 1, entered: 1 });
  });
});
