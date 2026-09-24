// The engine's reconnect schedule, against fake ports and a recording scheduler: capped so a node
// that comes back is reached within seconds, and none of it outliving the pages it served.

import { describe, expect, test } from 'bun:test';
import { frozenClock } from '@ultimat3/core';
import { FakeSocket } from './hooks-fixture';
import type { SyncTarget } from './page-store';
import { type PortLike, type PortMessage, SocketEngine } from './socket-engine';
import { BROWSER_RECONNECT_MAX_MS, browserBackoff } from './thundering-herd';

/** Far above any reconnect delay, so the beat and the reaper are told apart from the redial. */
const BEAT_MS = 1_000_000_000;

function rig(rng = () => 1) {
  const dialled: SyncTarget[] = [];
  const servers: FakeSocket[] = [];
  const redials: { fn: () => void; ms: number; live: boolean }[] = [];
  const engine = new SocketEngine({
    dial: (target) => {
      dialled.push(target);
      const socket = new FakeSocket();
      servers.push(socket);
      return socket;
    },
    scheduler: (fn, ms) => {
      const entry = { fn, ms, live: true };
      if (ms < BEAT_MS) redials.push(entry);
      return () => {
        entry.live = false;
      };
    },
    clock: frozenClock(1_000),
    heartbeatMs: BEAT_MS,
    rng,
  });
  const port = (): { port: PortLike; say(message: PortMessage): void } => {
    const p: PortLike = { postMessage: () => undefined, onmessage: null };
    engine.attach(p);
    return { port: p, say: (message) => p.onmessage?.({ data: message }) };
  };
  return { engine, dialled, servers, redials, port };
}

const b1: SyncTarget = { url: 'ws://node.test/_x/sync', buildId: 'b1' };

describe('SocketEngine — the reconnect schedule', () => {
  // Measured after a deploy: six dials in ~3s while the node was down, then none for 27s, so the
  // node that came back — and the update-available it would have sent — reached no tab.
  test('every wait is capped at a few seconds, however long the node stays down', () => {
    const r = rig(() => 1); // the worst roll the jitter can make
    const tab = r.port();
    tab.say({ t: 'open', target: b1 });
    for (let failure = 0; failure < 20; failure++) {
      r.servers.at(-1)?.close(1006); // the dial failed: the node is still down
      const redial = r.redials.at(-1);
      expect(redial?.ms).toBeLessThanOrEqual(BROWSER_RECONNECT_MAX_MS);
      redial?.fn();
      tab.say({ t: 'open', target: b1 }); // the tab's own retry re-asks
    }
    expect(r.dialled).toHaveLength(21);
    expect(BROWSER_RECONNECT_MAX_MS).toBeLessThanOrEqual(5_000);
  });

  // Core counts the first wait as attempt 1. Passing the engine's 0-based count straight through
  // would clamp the first two waits to the same base and shift the whole curve by one step.
  test('the first redial waits the base, and each failure after it doubles the ceiling', () => {
    const r = rig(() => 1); // equal jitter at the top roll answers the full ceiling
    const tab = r.port();
    tab.say({ t: 'open', target: b1 });
    for (let failure = 0; failure < 3; failure++) {
      r.servers.at(-1)?.close(1006);
      r.redials.at(-1)?.fn();
      tab.say({ t: 'open', target: b1 });
    }
    const base = browserBackoff.baseMs;
    expect(r.redials.map((redial) => redial.ms)).toEqual([base, base * 2, base * 4]);
  });

  test('a new page arriving while the node is down dials at once and restarts the curve', () => {
    const r = rig();
    const first = r.port();
    first.say({ t: 'open', target: b1 });
    for (let failure = 0; failure < 6; failure++) {
      r.servers.at(-1)?.close(1006);
      r.redials.at(-1)?.fn();
      first.say({ t: 'open', target: b1 });
    }
    r.servers.at(-1)?.close(1006); // a redial is now pending, far along the curve
    const before = r.dialled.length;
    const pending = r.redials.at(-1);

    r.port().say({ t: 'open', target: b1 });
    expect(r.dialled).toHaveLength(before + 1);
    expect(pending?.live).toBe(false);
    r.servers.at(-1)?.close(1006);
    expect(r.redials.at(-1)?.ms).toBe(r.redials[0]?.ms);
  });

  test('the last page leaving forgets the target, so the next page dials its own build', () => {
    const r = rig();
    const old = r.port();
    old.say({ t: 'open', target: b1 });
    old.say({ t: 'bye' });
    const b2: SyncTarget = { ...b1, buildId: 'b2' };
    r.port().say({ t: 'open', target: b2 });
    expect(r.dialled.map((target) => target.buildId)).toEqual(['b1', 'b2']);
  });
});
