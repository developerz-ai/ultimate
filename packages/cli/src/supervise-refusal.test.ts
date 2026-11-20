// A child's boot refusal, through both real halves: the child link decides (`refused`), the
// supervisor acts. A refusal the same image and environment meet again stops the container after
// ONE spawn; one that can heal by itself (a database still starting) is restarted with backoff.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import type { ChildHandle, SignalHub, SignalName, SupervisorTimers } from './supervise';
import { supervise } from './supervise';
import type { ChildLink, ChildLinkHost } from './supervise-child';
import { linkToSupervisor } from './supervise-child';
import type { ChildMessage } from './supervise-messages';

/** A child link whose only live seam is `send`, wired to the supervisor's IPC listener. */
const linkFor = (send: (message: ChildMessage) => void): ChildLink => {
  const host: ChildLinkHost = {
    send,
    onMessage: () => () => undefined,
    onDisconnect: () => () => undefined,
    onSignal: () => () => undefined,
    raise: () => undefined,
    ppid: () => 1,
    every: () => () => undefined,
    after: () => undefined,
    drain: async () => undefined,
    exit: () => undefined,
    budgetMs: () => 1_000,
  };
  return linkToSupervisor({ ULTIMATE_CHILD: '0/1' }, host) ?? expect.unreachable('a link');
};

function oneChild() {
  let now = 0;
  let queue: { at: number; run: () => void; id: number }[] = [];
  let ids = 0;
  const timers: SupervisorTimers = {
    now: () => now,
    setTimeout: (run, ms) => {
      ids += 1;
      queue.push({ at: now + ms, run, id: ids });
      return ids;
    },
    clearTimeout: (handle) => {
      queue = queue.filter((entry) => entry.id !== handle);
    },
  };
  const listeners = new Map<SignalName, () => void>();
  const signals: SignalHub = {
    on: (signal, listener) => listeners.set(signal, listener),
    off: (signal) => listeners.delete(signal),
  };
  const spawned: { link: ChildLink; exit: (code: number | null) => void }[] = [];
  const supervisor = supervise({
    count: 1,
    role: 'web',
    env: { NODE_ENV: 'production' },
    pool: 4,
    budgetMs: 1_000,
    timers,
    signals,
    spawn: ({ onMessage }) => {
      let exit!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => {
        exit = resolve;
      });
      const handle: ChildHandle = {
        pid: 3000 + spawned.length,
        exited,
        kill: () => undefined,
        send: () => undefined,
      };
      spawned.push({ link: linkFor((message) => onMessage(message)), exit });
      return handle;
    },
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    supervisor,
    spawned,
    signal: (name: SignalName) => listeners.get(name)?.(),
    /** The child boots, is refused with `code`, and exits 1 as an uncaught throw does. */
    async refuse(code: string): Promise<void> {
      const child = spawned.at(-1) ?? expect.unreachable('a spawned child');
      child.link.refused(new UltimateError({ code, cause: 'refused', fix: 'x doctor --json' }));
      child.exit(1);
      await flush();
    },
    async advance(ms: number): Promise<void> {
      const until = now + ms;
      for (;;) {
        await flush();
        const due = queue.filter((entry) => entry.at <= until).sort((a, b) => a.at - b.at)[0];
        if (due === undefined) break;
        queue = queue.filter((entry) => entry !== due);
        now = due.at;
        due.run();
      }
      now = until;
      await flush();
    },
  };
}

describe('unit · a refused boot under the supervisor', () => {
  test('X_ENV_MISSING stops the container with 1 after one spawn, never restarted', async () => {
    const h = oneChild();
    await h.refuse('X_ENV_MISSING');
    expect(await h.supervisor.done).toBe(1);
    await h.advance(120_000);
    expect(h.spawned).toHaveLength(1);
  });

  test('X_DB_UNAVAILABLE is restarted with backoff, as a crash is', async () => {
    const h = oneChild();
    await h.refuse('X_DB_UNAVAILABLE');
    await h.advance(999);
    expect(h.spawned).toHaveLength(1);
    await h.advance(1);
    expect(h.spawned).toHaveLength(2);
    await h.refuse('X_DB_UNAVAILABLE');
    await h.advance(1_999);
    expect(h.spawned).toHaveLength(2);
    await h.advance(1);
    expect(h.spawned).toHaveLength(3);
    h.signal('SIGTERM');
    h.spawned.at(-1)?.exit(0);
    expect(await h.supervisor.done).toBe(0);
  });

  test('migrations not yet applied heal by themselves: restarted, not fatal', async () => {
    const h = oneChild();
    await h.refuse('X_APP_MIGRATIONS_UNAPPLIED');
    await h.advance(1_000);
    expect(h.spawned).toHaveLength(2);
    h.signal('SIGTERM');
    h.spawned.at(-1)?.exit(0);
    expect(await h.supervisor.done).toBe(0);
  });
});
