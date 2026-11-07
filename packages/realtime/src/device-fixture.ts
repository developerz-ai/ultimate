// Test doubles for the device socket: a scheduler time is moved by hand, a socket that records what
// it was sent and how it was closed, and an upgrade target that opens it the way Bun does —
// synchronously, inside `upgrade`.

import type { Actor, FrozenClock } from '@ultimat3/core';
import { frozenClock, userActor } from '@ultimat3/core';
import type { DeviceWs } from './device-host';
import type { DeviceUpgradeTarget, DeviceWsData } from './device-upgrade';
import type { Scheduler } from './thundering-herd';

export interface ManualScheduler {
  readonly schedule: Scheduler;
  /** Moves the clock and runs every timer due, in order, including ones a timer arms. */
  advance(ms: number): void;
  readonly pending: number;
}

export function manualScheduler(clock: FrozenClock): ManualScheduler {
  let timers: { at: number; fn: () => void; id: number }[] = [];
  let next = 0;
  let now = 0;
  return {
    schedule: (fn, ms) => {
      const id = next++;
      timers.push({ at: now + ms, fn, id });
      return () => {
        timers = timers.filter((timer) => timer.id !== id);
      };
    },
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = timers.filter((timer) => timer.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        timers = timers.filter((timer) => timer.id !== due.id);
        clock.advance(due.at - now);
        now = due.at;
        due.fn();
      }
      clock.advance(until - now);
      now = until;
    },
    get pending() {
      return timers.length;
    },
  };
}

export interface FakeDeviceWs extends DeviceWs {
  readonly sent: unknown[];
  closed: { code: number | undefined; reason: string | undefined } | null;
}

export function fakeWs(data: DeviceWsData, onClose?: (ws: FakeDeviceWs) => void): FakeDeviceWs {
  const ws: FakeDeviceWs = {
    data,
    sent: [],
    closed: null,
    send(text) {
      ws.sent.push(JSON.parse(text));
      return text.length;
    },
    close(code, reason) {
      if (ws.closed !== null) return;
      ws.closed = { code, reason };
      onClose?.(ws);
    },
  };
  return ws;
}

/** Opens the socket inside `upgrade`, as Bun does, and closes it through the mount's handler. */
export function upgradeTarget(handlers: {
  open(ws: DeviceWs): void;
  close(ws: DeviceWs): void;
}): DeviceUpgradeTarget & { readonly sockets: FakeDeviceWs[]; upgrades: number } {
  const target = {
    sockets: [] as FakeDeviceWs[],
    upgrades: 0,
    upgrade(_request: Request, options: { data: DeviceWsData }) {
      target.upgrades += 1;
      const ws = fakeWs(options.data, (closed) => handlers.close(closed));
      target.sockets.push(ws);
      handlers.open(ws);
      return true;
    },
    requestIP: () => ({ address: '203.0.113.7' }),
  };
  return target;
}

export const ORG_A = '00000000-0000-4000-8000-00000000000a';
export const ORG_B = '00000000-0000-4000-8000-00000000000b';

export const deviceActor = (id: string, orgId: string = ORG_A): Actor => userActor({ id, orgId });

/** An upgrade request to `path`, with a bearer token unless `token` is `null`. */
export function upgradeRequest(
  path: string,
  token: string | null,
  headers: Readonly<Record<string, string>> = {},
): Request {
  return new Request(`http://app.test${path}`, {
    headers: {
      upgrade: 'websocket',
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
      ...headers,
    },
  });
}

export const testClock = (): FrozenClock => frozenClock('2026-11-06T12:00:00.000Z');
