// A page held open THROUGH a bus outage. The node answers the page's beat with an `ack` carrying
// `X_TRANSPORT_UNAVAILABLE` for as long as its bus is away; that is the node saying "not now",
// never a decision about this subscriber. Until 2026-10-10 the client marked the membership `failed`
// and nothing cleared it: events flowed again and `useChannel()` read `failed` until a reload.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import type { PresenceEvent } from './channel-presence';
import { cursorsChannel, harness } from './client-harness-fixture';
import { DEFAULT_HEARTBEAT_MS } from './client-heartbeat';
import { type Frame, PROTOCOL_VERSION, type WireError } from './sync-protocol';

const TOPIC = 'org-cursors.o1';
const SID = `channel:${TOPIC}`;

const BUS_AWAY: WireError = {
  code: 'X_TRANSPORT_UNAVAILABLE',
  cause: 'transport "nats" is unavailable: the connection dropped',
  fix: 'x doctor — then check NATS_URL points at a reachable nats-server',
};
const FORBIDDEN: WireError = { code: 'X_TOPIC_FORBIDDEN', cause: 'no', fix: 'x policy list' };

const ack = (ref: string, error: WireError): Frame => ({
  type: 'ack',
  v: PROTOCOL_VERSION,
  ref,
  lsn: null,
  error,
});

const roster = (ids: readonly string[]): Frame => ({
  type: 'events',
  v: PROTOCOL_VERSION,
  channel: TOPIC,
  event: {
    presence: 'sync',
    members: ids.map((id) => ({ id, actorId: null, meta: {}, updatedAt: 1 })),
    total: ids.length,
  },
});

function joined() {
  const rig = harness({ heartbeatMs: DEFAULT_HEARTBEAT_MS });
  rig.client.connect();
  const socket = rig.sockets[0];
  socket?.open();
  const rosters: PresenceEvent[] = [];
  const membership = rig.client.holdChannel(
    cursorsChannel,
    { orgId: 'o1' },
    { onPresence: (event) => rosters.push(event) },
  );
  socket?.deliver(roster(['me']));
  const beats = (): number =>
    (socket?.frames() ?? []).filter((frame) => frame.type === 'subscribe' && frame.op === 'add')
      .length;
  return { ...rig, socket, membership, rosters, beats };
}

describe('a channel membership whose node lost its bus', () => {
  test('is `joining` while the beat is refused, re-asked on every beat, and `live` on the first answer', () => {
    const { socket, membership, timers, rosters, beats, errors } = joined();
    expect(membership.state()).toBe('live');
    const states: string[] = [];
    membership.onChange(() => states.push(membership.state()));

    // Three beats into the outage: each one is refused, and each next one is still sent.
    for (let beat = 0; beat < 3; beat += 1) {
      timers.fire();
      socket?.deliver(ack(SID, BUS_AWAY));
      expect(membership.state()).toBe('joining');
      expect(membership.error()).toBeUndefined();
    }
    expect(beats()).toBe(4);
    // Told once: three refusals are one transition, never three re-renders.
    expect(states).toEqual(['joining']);

    // The bus is back: the next beat is answered with the room's roster.
    timers.fire();
    expect(beats()).toBe(5);
    socket?.deliver(roster(['me', 'you']));
    expect(membership.state()).toBe('live');
    expect(states).toEqual(['joining', 'live']);
    expect(rosters.at(-1)?.members.map((member) => member.id)).toEqual(['me', 'you']);
    // A subscription the client holds is never reported as an unowned refusal.
    expect(errors).toEqual([]);
  });

  test('a page opened DURING the outage is refused its first subscribe and still goes live', () => {
    const rig = harness({ heartbeatMs: DEFAULT_HEARTBEAT_MS });
    rig.client.connect();
    rig.sockets[0]?.open();
    const membership = rig.client.holdChannel(cursorsChannel, { orgId: 'o1' });
    rig.sockets[0]?.deliver(ack(SID, BUS_AWAY));
    expect(membership.state()).toBe('joining');
    rig.timers.fire();
    // A fresh seat on a records channel is answered with a `replay-gap`: one catch-up read.
    rig.sockets[0]?.deliver({
      type: 'replay-gap',
      v: PROTOCOL_VERSION,
      channel: TOPIC,
      epoch: 'e1',
    });
    expect(membership.state()).toBe('catching-up');
  });

  test('a policy refusal stays terminal, with the node’s own error — and a later outage does not hide it', () => {
    const { socket, membership } = joined();
    socket?.deliver(ack(SID, FORBIDDEN));
    expect(membership.state()).toBe('failed');
    const refusal = membership.error();
    expect(isUltimateError(refusal) ? refusal.code : refusal).toBe('X_TOPIC_FORBIDDEN');

    socket?.deliver(ack(SID, BUS_AWAY));
    expect(membership.state()).toBe('failed');
    socket?.deliver(roster(['me']));
    expect(membership.state()).toBe('failed');
  });
});
