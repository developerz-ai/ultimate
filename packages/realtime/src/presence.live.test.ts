// Presence over a real nats-server, reached the way a boot reaches it: `selectTransport(env)`, not
// a hand-built transport. The in-memory server cannot catch a bucket the selector named differently
// from the one the KV set writes to, or a TTL that never left the selection — and "presence
// survives a node loss" is a claim about two processes, which is the one thing a unit test cannot be.
//
// Skips unless a JetStream-enabled server is configured. Locally:
//
//   docker run -d --name x-nats -p 4222:4222 nats:2.11-alpine -js
//   TEST_NATS_URL=nats://localhost:4222 bun test packages/realtime/src/presence.live.test.ts

import { afterAll, describe, expect, test } from 'bun:test';
import { topic } from './channel';
import { PresenceRegistry } from './presence';
import { selectTransport, type TransportSelection } from './transport-env';

const url = Bun.env['TEST_NATS_URL'];
const BUCKET = 'xlivepresence';
const ROOM = topic('org', 'o1', 'cursors');

const selected: TransportSelection[] = [];

/** One node: its own connection, its own registry, the same bucket the env names. */
async function node(ttlMs?: number): Promise<PresenceRegistry> {
  const selection = selectTransport(
    { NATS_URL: url ?? '', NATS_KV_BUCKET: BUCKET },
    ttlMs === undefined ? {} : { presenceTtlMs: ttlMs },
  );
  selected.push(selection);
  await selection.connect();
  return new PresenceRegistry({
    transport: selection.transport,
    ttlMs: selection.presenceTtlMs,
  });
}

afterAll(async () => {
  for (const selection of selected) await selection.transport.close();
});

describe.skipIf(url === undefined)('presence over a real bus', () => {
  test('a member joined on one node is listed on another', async () => {
    const first = await node();
    const second = await node();
    await first.leave(ROOM, 'alice-socket');

    await first.join(ROOM, { id: 'alice-socket', actorId: 'alice', meta: { x: 3, y: 7 } });

    const seen = await second.list(ROOM);
    expect(seen.map((member) => member.id)).toEqual(['alice-socket']);
    expect(seen[0]?.actorId).toBe('alice');
    // The metadata a cursor rides in, round-tripped through the KV value rather than assumed.
    expect(seen[0]?.meta).toEqual({ x: 3, y: 7 });
    await first.leave(ROOM, 'alice-socket');
  });

  test('a leave on one node empties the room on the other', async () => {
    const first = await node();
    const second = await node();
    await first.join(ROOM, { id: 'bob-socket', actorId: 'bob' });
    expect((await second.list(ROOM)).map((member) => member.id)).toEqual(['bob-socket']);

    await first.leave(ROOM, 'bob-socket');

    expect(await second.list(ROOM)).toHaveLength(0);
  });

  test('a node that stops beating expires on the server, and the other node sweeps it', async () => {
    // Short enough to expire inside a test, and the server is what decides — no client clock
    // participates. This is the claim that makes `sync` stateless, so it is proven, not asserted.
    const dying = await node(1_000);
    const survivor = await node(1_000);
    const room = topic('org', 'o1', 'expiry');
    await survivor.join(room, { id: 'watcher', actorId: 'watcher' });
    await dying.join(room, { id: 'lost', actorId: 'lost' });
    expect((await survivor.list(room)).map((member) => member.id).sort()).toEqual([
      'lost',
      'watcher',
    ]);

    // A node announces a leave only for members a sweep has already seen — which is why the node
    // runs one on an interval rather than on demand. This is that first pass, with `lost` alive.
    expect(await survivor.sweepAll()).toHaveLength(0);

    // `dying` stops heartbeating: its node is gone. Nothing cleans up on its behalf.
    for (let beat = 0; beat < 6; beat += 1) {
      await Bun.sleep(500);
      await survivor.heartbeat(room, 'watcher');
    }

    const gone = await survivor.sweepAll();
    expect(gone.map((member) => member.id)).toEqual(['lost']);
    expect((await survivor.list(room)).map((member) => member.id)).toEqual(['watcher']);
    await survivor.leave(room, 'watcher');
  }, 30_000);
});
