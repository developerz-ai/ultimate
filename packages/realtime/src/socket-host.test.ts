// Host selection: a SharedWorker when there is one, the in-page engine when there is not — absent,
// or refused by the browser — and one worker per principal, never a socket shared across two.

import { describe, expect, test } from 'bun:test';
import { FakeSocket } from './hooks-fixture';
import {
  openHost,
  rehosting,
  type SharedWorkerLike,
  type SocketHost,
  workerName,
} from './socket-host';
import type { Scheduler } from './thundering-herd';

/** A SharedWorker double: records the name it was constructed with, hands back a real port. */
function recordingWorker(names: string[]): SharedWorkerLike {
  return class {
    readonly port: MessagePort;
    constructor(_url: string, options: { name: string }) {
      names.push(options.name);
      this.port = new MessageChannel().port1;
    }
  };
}

const refusingWorker: SharedWorkerLike = class {
  readonly port: MessagePort = new MessageChannel().port1;
  constructor() {
    throw new TypeError('SharedWorker is disabled in this context');
  }
};

describe('openHost', () => {
  test('a built worker and a SharedWorker: the worker hosts the socket, named by principal', () => {
    const names: string[] = [];
    const host = openHost({
      workerUrl: '/_x/sync-worker/abc.js',
      scope: 'alice',
      sharedWorker: recordingWorker(names),
    });
    expect(host.kind).toBe('worker');
    expect(names).toEqual([workerName('alice', undefined)]);
    host.bye();
  });

  test('no SharedWorker in this browser is the in-page host', () => {
    const host = openHost({ workerUrl: '/_x/sync-worker/abc.js', scope: 'alice' });
    // Bun has no SharedWorker, which is exactly the case.
    expect(typeof SharedWorker).toBe('undefined');
    expect(host.kind).toBe('in-page');
    host.bye();
  });

  test('a constructor that throws (sandboxed iframe) is the in-page host, never an error', () => {
    const host = openHost({ workerUrl: '/w.js', scope: 'alice', sharedWorker: refusingWorker });
    expect(host.kind).toBe('in-page');
    host.bye();
  });

  test('no worker built is the in-page host', () => {
    const names: string[] = [];
    const host = openHost({ scope: 'alice', sharedWorker: recordingWorker(names) });
    expect(host.kind).toBe('in-page');
    expect(names).toEqual([]);
    host.bye();
  });

  test('a principal change is a different worker name — two principals never share a socket', () => {
    expect(workerName('alice', 'b1')).not.toBe(workerName('bob', 'b1'));
    expect(workerName(null, 'b1')).not.toBe(workerName('alice', 'b1'));
  });

  // A SharedWorker keeps the first tab's build for its whole life, so a tab of the NEW build joined
  // the old engine and was told "update available" about itself. One engine per build.
  test('a new build is a different worker name — two builds never share an engine', () => {
    expect(workerName('alice', 'b1')).not.toBe(workerName('alice', 'b2'));
    const names: string[] = [];
    openHost({
      workerUrl: '/w.js',
      scope: 'alice',
      buildId: 'b2',
      sharedWorker: recordingWorker(names),
    }).bye();
    expect(names).toEqual([workerName('alice', 'b2')]);
  });
});

/** Hosts whose sockets never answer `open` until told to — a reaped port, or a dead worker. */
function silentHosts(): {
  made: { byes: number; sockets: FakeSocket[] }[];
  make: () => SocketHost;
} {
  const made: { byes: number; sockets: FakeSocket[] }[] = [];
  return {
    made,
    make: () => {
      const record = { byes: 0, sockets: [] as FakeSocket[] };
      made.push(record);
      return {
        kind: 'worker',
        socket: () => {
          const socket = new FakeSocket();
          record.sockets.push(socket);
          return socket;
        },
        bye: () => {
          record.byes += 1;
        },
      };
    },
  };
}

function manual(): { schedule: Scheduler; fire: () => void } {
  let armed: (() => void)[] = [];
  return {
    schedule: (fn) => {
      armed.push(fn);
      return () => {
        armed = armed.filter((one) => one !== fn);
      };
    },
    fire: () => {
      const due = armed;
      armed = [];
      for (const fn of due) fn();
    },
  };
}

// A reaped port, or `bye` on `pagehide` followed by a bfcache restore, left the tab dialling a port
// nobody reads: the virtual socket waited for `open` forever and realtime was dead until a reload.
describe('rehosting', () => {
  test('an open unanswered by the deadline closes the socket and re-hosts on a new port', () => {
    const { made, make } = silentHosts();
    const timers = manual();
    const host = rehosting(make, { openTimeoutMs: 30_000, schedule: timers.schedule });
    const closed: number[] = [];
    const first = host.socket({ url: 'ws://x/_x/sync', buildId: 'b1' });
    first.onClose((code) => closed.push(code));
    timers.fire();
    expect(closed).toEqual([1006]);
    expect(made).toHaveLength(2);
    expect(made[0]?.byes).toBe(1);
    // The client's redial lands on the NEW host.
    host.socket({ url: 'ws://x/_x/sync', buildId: 'b1' });
    expect(made[1]?.sockets).toHaveLength(1);
  });

  test('an open that IS answered disarms the deadline', () => {
    const { made, make } = silentHosts();
    const timers = manual();
    const host = rehosting(make, { openTimeoutMs: 30_000, schedule: timers.schedule });
    let opened = false;
    const socket = host.socket({ url: 'ws://x/_x/sync', buildId: 'b1' });
    socket.onOpen(() => {
      opened = true;
    });
    made[0]?.sockets[0]?.open();
    timers.fire();
    expect(opened).toBe(true);
    expect(made).toHaveLength(1);
  });

  test('rehost() on demand says bye to the old host and builds a new one', () => {
    const { made, make } = silentHosts();
    const host = rehosting(make, { openTimeoutMs: 30_000, schedule: manual().schedule });
    host.rehost();
    expect(made.map((one) => one.byes)).toEqual([1, 0]);
  });
});
