// The order this node applies one socket's inbound frames in. `sync-node.message` dispatches every
// frame as `void (async () => routeFrame(…))()`, so nothing upstream orders them and a router that
// awaits a policy, a snapshot read or `onMutate` finishes in whatever order those settle.
//
// **Not one lane per socket.** A global per-socket lane puts every frame behind the slowest one,
// and the slowest one is a snapshot read — a database round trip that every reconnecting client
// pays once per live query, which is precisely the 50,000-client restart storm this framework is
// measured on. What has to be ordered is narrower and exact:
//
// | Frames | Lane | Why that is the unit |
// |---|---|---|
// | `mutate` | `mutate` (one per socket) | they write the database, and the client numbered them |
// | `subscribe` on a query | `sub:<sid>` | `add` then `drop` for one sid, or the drop finds nothing and the add strands the subscription it was meant to end |
// | `subscribe` on a topic | `topic:<name>` | the same add/drop pair, one membership |
// | `hello`, server-authored kinds | none | they read state and write none of it |
//
// The caps are NOT this file's job — a lane makes concurrent frames sequential, and N sequential
// subscribes still pass a check-then-act cap N times. `SubscriptionBook.reserve` and
// `ChannelHub`'s bridge reservation are what bound them, synchronously, before the first await.

import type { Frame } from './sync-protocol';
import { WindowLock } from './window-lock';

/**
 * FIFO per key, concurrent across keys. A lane exists only while something is queued on it, so the
 * map is empty between frames — keyed by a client-chosen sid, a lane that outlived its work would
 * be an unbounded map one socket could grow at will.
 */
export class FrameLanes {
  readonly #lanes = new Map<string, { lock: WindowLock; queued: number }>();

  run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const lane = this.#lanes.get(key) ?? { lock: new WindowLock(), queued: 0 };
    lane.queued += 1;
    this.#lanes.set(key, lane);
    const result = lane.lock.run(work);
    const done = (): void => {
      lane.queued -= 1;
      // Only when nothing is waiting: dropping a lane with work still queued on it would let the
      // next frame open a second lane beside the first and overtake it.
      if (lane.queued === 0 && this.#lanes.get(key) === lane) this.#lanes.delete(key);
    };
    result.then(done, done);
    return result;
  }

  /** Test-only probe: lanes still held. A count that does not return to zero is the leak. */
  get size(): number {
    return this.#lanes.size;
  }
}

/** The lane a frame belongs in, or `null` for the kinds nothing has to order. */
export function laneKeyOf(frame: Frame): string | null {
  if (frame.type === 'mutate') return 'mutate';
  if (frame.type !== 'subscribe') return null;
  return frame.target.kind === 'topic' ? `topic:${frame.target.topic}` : `sub:${frame.sid}`;
}
