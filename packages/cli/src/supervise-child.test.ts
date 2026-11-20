// The child's half with a fake host: unsupervised is no link, the ack goes out once on the first
// signal, a drain message takes the signal's own path, and a gone supervisor — by disconnect or by
// a changed ppid — drains the child with a hard exit armed behind it.

import { describe, expect, test } from 'bun:test';
import { installLogSink, UltimateError } from '@ultimat3/core';
import type { ChildLinkHost } from './supervise-child';
import { linkToSupervisor, ORPHAN_EXIT_SLACK_MS } from './supervise-child';
import type { ChildMessage, DrainSignal } from './supervise-messages';

function fakeHost() {
  const sent: ChildMessage[] = [];
  const signalListeners = new Map<DrainSignal, (() => void)[]>();
  let message: ((value: unknown) => void) | undefined;
  let disconnect: (() => void) | undefined;
  let poll: (() => void) | undefined;
  let ppid = 4000;
  const raised: DrainSignal[] = [];
  const drained: string[] = [];
  const armed: number[] = [];
  let released = 0;
  const host: ChildLinkHost = {
    send: (value) => sent.push(value),
    onMessage: (listener) => {
      message = listener;
      return () => {
        released += 1;
      };
    },
    onDisconnect: (listener) => {
      disconnect = listener;
      return () => {
        released += 1;
      };
    },
    onSignal: (signal, listener) => {
      signalListeners.set(signal, [...(signalListeners.get(signal) ?? []), listener]);
      return () => {
        released += 1;
      };
    },
    raise: (signal) => {
      raised.push(signal);
      for (const listener of signalListeners.get(signal) ?? []) listener();
    },
    ppid: () => ppid,
    every: (_ms, run) => {
      poll = run;
      return () => {
        released += 1;
      };
    },
    after: (ms) => armed.push(ms),
    drain: async (reason) => {
      drained.push(reason);
    },
    exit: () => undefined,
    budgetMs: () => 31_000,
  };
  return {
    host,
    sent,
    raised,
    drained,
    armed,
    released: () => released,
    signal: (name: DrainSignal) => host.raise(name),
    message: (value: unknown) => message?.(value),
    disconnect: () => disconnect?.(),
    reparent: (to: number) => {
      ppid = to;
      poll?.();
    },
    poll: () => poll?.(),
  };
}

const CHILD = { ULTIMATE_CHILD: '1/2' };

describe('unit · linkToSupervisor', () => {
  test('a process no supervisor started has no link', () => {
    expect(linkToSupervisor({}, fakeHost().host)).toBeUndefined();
  });

  test('ready names the loopback scrape and the drain bound', () => {
    const fake = fakeHost();
    const link = linkToSupervisor(CHILD, fake.host);
    expect(link).toMatchObject({ index: 1, count: 2 });
    link?.ready('http://127.0.0.1:41000');
    expect(fake.sent).toEqual([
      { type: 'x-proc', event: 'ready', metricsUrl: 'http://127.0.0.1:41000', budgetMs: 31_000 },
    ]);
  });

  test('the first signal is acknowledged once, whatever follows', () => {
    const fake = fakeHost();
    linkToSupervisor(CHILD, fake.host);
    fake.signal('SIGTERM');
    fake.signal('SIGINT');
    expect(fake.sent).toEqual([{ type: 'x-proc', event: 'draining', budgetMs: 31_000 }]);
  });

  test("the supervisor's drain message raises the signal, so core's own handlers drain", () => {
    const fake = fakeHost();
    linkToSupervisor(CHILD, fake.host);
    fake.message({ type: 'x-proc', event: 'drain', signal: 'SIGTERM' });
    fake.message({ type: 'other', event: 'drain', signal: 'SIGTERM' });
    expect(fake.raised).toEqual(['SIGTERM']);
    expect(fake.sent.map((message) => message.event)).toEqual(['draining']);
  });

  test('a closed channel drains the child, with a hard exit armed past its bound', () => {
    const fake = fakeHost();
    linkToSupervisor(CHILD, fake.host);
    fake.disconnect();
    fake.disconnect();
    expect(fake.drained).toEqual(['supervisor-gone']);
    expect(fake.armed).toEqual([31_000 + ORPHAN_EXIT_SLACK_MS]);
  });

  test('the ppid is compared to the ORIGINAL one, never to 1', () => {
    const fake = fakeHost();
    linkToSupervisor(CHILD, fake.host);
    fake.poll();
    expect(fake.drained).toEqual([]);
    fake.reparent(1013);
    expect(fake.drained).toEqual(['supervisor-gone']);
  });

  test('gone and fatal are said; release lets go of every listener', () => {
    const fake = fakeHost();
    const link = linkToSupervisor(CHILD, fake.host);
    link?.gone(70);
    link?.fatal('X_PROCESSES_UNSHARED_STATE');
    expect(fake.sent).toEqual([
      { type: 'x-proc', event: 'gone', code: 70 },
      { type: 'x-proc', event: 'fatal', code: 'X_PROCESSES_UNSHARED_STATE' },
    ]);
    link?.release();
    expect(fake.released()).toBe(6);
  });

  test('a refused boot is one logged error line, and fatal only when no restart can fix it', () => {
    const fake = fakeHost();
    const link = linkToSupervisor(CHILD, fake.host);
    const lines: string[] = [];
    const release = installLogSink((line) => {
      lines.push(line);
    });
    try {
      link?.refused(
        new UltimateError({
          code: 'X_DB_UNAVAILABLE',
          cause: 'no answer on 5432',
          fix: 'x doctor --json',
        }),
      );
      link?.refused(
        new UltimateError({
          code: 'X_PROCESSES_UNSHARED_STATE',
          cause: 'the lru tier',
          fix: 'ULTIMATE_PROCESSES=1',
        }),
      );
    } finally {
      release();
    }
    // Through the logger, so the line carries this child's `child` field: Bun's own print of an
    // uncaught throw names no child, and the crash loop's fix sends the operator to that line.
    const refused = lines.filter((line) => line.includes('"msg":"ultimate child refused to boot"'));
    expect(refused).toHaveLength(2);
    expect(refused[0]).toContain('"level":"error"');
    expect(refused[0]).toContain('"code":"X_DB_UNAVAILABLE"');
    expect(refused[0]).toContain('"fix":"x doctor --json"');
    expect(fake.sent).toEqual([
      { type: 'x-proc', event: 'fatal', code: 'X_PROCESSES_UNSHARED_STATE' },
    ]);
  });
});
