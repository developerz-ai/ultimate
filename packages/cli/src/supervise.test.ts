// The supervisor with fake children and a hand-turned clock: what each child is started with,
// backoff, the crash loop, the drain fan-out and its two bounds, the exit code, and readiness.
// The real processes on one port are `supervise.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { ChildHandle, SignalHub, SignalName, SupervisorTimers } from './supervise';
import { HEALTH_FAILURES, HEALTH_POLL_MS, OUTER_SLACK_MS, supervise } from './supervise';
import type { DrainMessage } from './supervise-messages';

interface FakeChild extends ChildHandle {
  readonly index: number;
  readonly env: Record<string, string | undefined>;
  readonly signals: string[];
  readonly sent: DrainMessage[];
  say(message: unknown): void;
  exit(code: number | null): void;
}

function harness(
  options: {
    count?: number;
    role?: 'web' | 'worker';
    healthy?: (url: string) => Promise<boolean>;
  } = {},
) {
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
  const children: FakeChild[] = [];
  const supervisor = supervise({
    count: options.count ?? 2,
    role: options.role ?? 'web',
    env: { NODE_ENV: 'production' },
    pool: 5,
    budgetMs: 1_000,
    timers,
    signals,
    ...(options.healthy === undefined ? {} : { healthy: options.healthy }),
    spawn: ({ index, env, onMessage }) => {
      let exit!: (code: number | null) => void;
      const exited = new Promise<number | null>((resolve) => {
        exit = resolve;
      });
      const child: FakeChild = {
        index,
        env,
        pid: 1000 + children.length,
        exited,
        signals: [],
        sent: [],
        kill(signal) {
          this.signals.push(signal);
        },
        send(message) {
          this.sent.push(message);
        },
        say: onMessage,
        exit,
      };
      children.push(child);
      return child;
    },
  });
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));
  return {
    supervisor,
    children,
    listeners,
    signal: (name: SignalName) => listeners.get(name)?.(),
    /** Every timer due within `ms`, in order, with the promise queue drained between them. */
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
    flush,
    ready: (child: FakeChild) =>
      child.say({
        type: 'x-proc',
        event: 'ready',
        metricsUrl: `http://127.0.0.1:${String(9000 + child.index)}`,
        budgetMs: 1_000,
      }),
  };
}

describe('unit · supervise — starting', () => {
  test('signal handlers are installed before the first child, and each child is told its place and pool share', () => {
    const h = harness({ count: 2 });
    expect([...h.listeners.keys()]).toEqual(['SIGTERM', 'SIGINT', 'SIGUSR2', 'exit']);
    expect(
      h.children.map((child) => [child.env['ULTIMATE_CHILD'], child.env['DATABASE_POOL_MAX']]),
    ).toEqual([
      ['0/2', '3'],
      ['1/2', '2'],
    ]);
    expect(h.children[0]?.env['NODE_ENV']).toBe('production');
  });
});

describe('unit · supervise — readiness', () => {
  test('ready only once every child said so; a child restarting takes it back', async () => {
    const h = harness();
    const [a, b] = h.children;
    if (a === undefined || b === undefined) return expect.unreachable('two children');
    expect(h.supervisor.view.ready()).toBe(false);
    h.ready(a);
    expect(h.supervisor.view.ready()).toBe(false);
    h.ready(b);
    expect(h.supervisor.view.ready()).toBe(true);
    expect(h.supervisor.view.children().map((child) => child.metricsUrl)).toEqual([
      'http://127.0.0.1:9000',
      'http://127.0.0.1:9001',
    ]);
    a.exit(1);
    await h.flush();
    expect(h.supervisor.view.ready()).toBe(false);
  });

  test('a message that is not ours is ignored', () => {
    const h = harness({ count: 1 });
    h.children[0]?.say({ event: 'ready', metricsUrl: 'x', budgetMs: 1 });
    h.children[0]?.say('ready');
    expect(h.supervisor.view.ready()).toBe(false);
  });
});

describe('unit · supervise — restarts', () => {
  test('backoff doubles 1 s, 2 s, 4 s and resets after a minute up', async () => {
    const h = harness({ count: 1 });
    const crashAndWait = async (expectedDelay: number): Promise<void> => {
      const before = h.children.length;
      h.children.at(-1)?.exit(1);
      await h.advance(expectedDelay - 1);
      expect(h.children.length).toBe(before);
      await h.advance(1);
      expect(h.children.length).toBe(before + 1);
    };
    await crashAndWait(1_000);
    await crashAndWait(2_000);
    await crashAndWait(4_000);
    await h.advance(60_000);
    await crashAndWait(1_000);
  });

  test('five crashes of one child in five minutes drain its siblings and exit 1', async () => {
    const h = harness({ count: 2 });
    for (let crash = 0; crash < 4; crash += 1) {
      h.children
        .filter((child) => child.index === 0)
        .at(-1)
        ?.exit(1);
      await h.advance(20_000);
    }
    const sibling = h.children[1];
    h.children
      .filter((child) => child.index === 0)
      .at(-1)
      ?.exit(1);
    await h.flush();
    expect(sibling?.signals).toEqual(['SIGTERM']);
    expect(h.supervisor.view.live()).toBe(false);
    sibling?.exit(0);
    expect(await h.supervisor.done).toBe(1);
  });

  test('never restarts while draining', async () => {
    const h = harness({ count: 2 });
    h.signal('SIGTERM');
    h.children[0]?.exit(1);
    await h.advance(60_000);
    expect(h.children).toHaveLength(2);
  });

  test('a child that refuses to serve (fatal) stops the container with 1, no restart', async () => {
    const h = harness({ count: 2 });
    h.children[0]?.say({ type: 'x-proc', event: 'fatal', code: 'X_PROCESSES_UNSHARED_STATE' });
    h.children[0]?.exit(1);
    h.children[1]?.exit(0);
    expect(await h.supervisor.done).toBe(1);
    expect(h.children).toHaveLength(2);
  });

  test('three failed health polls over the window restart the child by drain', async () => {
    const h = harness({ count: 1, healthy: async () => false });
    const child = h.children[0];
    if (child === undefined) return expect.unreachable('one child');
    h.ready(child);
    await h.advance(HEALTH_POLL_MS * 2);
    expect(child.sent).toEqual([]);
    await h.advance(HEALTH_POLL_MS);
    expect(child.sent).toEqual([{ type: 'x-proc', event: 'drain', signal: 'SIGTERM' }]);
  });

  test('a child restarted for its health that never drains is killed past its bound, not left', async () => {
    const h = harness({ count: 1, healthy: async () => false });
    const child = h.children[0];
    if (child === undefined) return expect.unreachable('one child');
    h.ready(child);
    await h.advance(HEALTH_POLL_MS * 3);
    expect(child.sent).toHaveLength(1);
    await h.advance(1_000 + OUTER_SLACK_MS);
    expect(child.signals).toEqual(['SIGKILL']);
    child.exit(null);
    await h.advance(1_000);
    expect(h.children).toHaveLength(2);
  });

  test('the failures that restart a child span more than 6 s: a saturated child answers late', () => {
    expect((HEALTH_FAILURES - 1) * HEALTH_POLL_MS).toBeGreaterThan(6_000);
  });

  test('a healthy answer resets the count', async () => {
    const answers = [false, false, true, false, false];
    const h = harness({ count: 1, healthy: async () => answers.shift() ?? true });
    const child = h.children[0];
    if (child === undefined) return expect.unreachable('one child');
    h.ready(child);
    await h.advance(HEALTH_POLL_MS * 6);
    expect(child.sent).toEqual([]);
  });
});

describe('unit · supervise — drain', () => {
  test('SIGTERM reaches every child at once, and all exiting 0 is exit 0', async () => {
    const h = harness({ count: 3 });
    h.signal('SIGTERM');
    expect(h.children.map((child) => child.signals)).toEqual([
      ['SIGTERM'],
      ['SIGTERM'],
      ['SIGTERM'],
    ]);
    for (const child of h.children) child.exit(0);
    expect(await h.supervisor.done).toBe(0);
    expect(h.listeners.size).toBe(0);
  });

  test("a child's bound starts at its ack: past it plus slack, SIGKILL, and the exit is 70", async () => {
    const h = harness({ count: 2 });
    const [a, b] = h.children;
    if (a === undefined || b === undefined) return expect.unreachable('two children');
    h.signal('SIGTERM');
    await h.advance(4_000);
    a.say({ type: 'x-proc', event: 'draining', budgetMs: 1_000 });
    await h.advance(2_999);
    expect(a.signals).toEqual(['SIGTERM']);
    await h.advance(1);
    expect(a.signals).toEqual(['SIGTERM', 'SIGKILL']);
    a.exit(null);
    b.exit(0);
    expect(await h.supervisor.done).toBe(70);
  });

  test('a child that never acks is killed at the outer ceiling', async () => {
    const h = harness({ count: 1 });
    h.signal('SIGINT');
    await h.advance(1_000 + OUTER_SLACK_MS - 1);
    expect(h.children[0]?.signals).toEqual(['SIGINT']);
    await h.advance(1);
    expect(h.children[0]?.signals).toEqual(['SIGINT', 'SIGKILL']);
    h.children[0]?.exit(null);
    expect(await h.supervisor.done).toBe(70);
  });

  test("any child's 70 is the container's 70; another failure is 1", async () => {
    const seventy = harness({ count: 2 });
    seventy.signal('SIGTERM');
    seventy.children[0]?.exit(70);
    seventy.children[1]?.exit(0);
    expect(await seventy.supervisor.done).toBe(70);
    const one = harness({ count: 2 });
    one.signal('SIGTERM');
    one.children[0]?.exit(0);
    one.children[1]?.exit(3);
    expect(await one.supervisor.done).toBe(1);
  });

  test('SIGUSR2 retires a worker container, and a later SIGTERM still arms the ceiling', async () => {
    const h = harness({ count: 2, role: 'worker' });
    h.signal('SIGUSR2');
    expect(h.children.map((child) => child.signals)).toEqual([['SIGUSR2'], ['SIGUSR2']]);
    h.children[0]?.exit(0);
    await h.advance(60_000);
    expect(h.children).toHaveLength(2);
    h.signal('SIGTERM');
    expect(h.children[1]?.signals).toEqual(['SIGUSR2', 'SIGTERM']);
    await h.advance(1_000 + OUTER_SLACK_MS);
    expect(h.children[1]?.signals.at(-1)).toBe('SIGKILL');
  });

  test('SIGUSR2 on a web container is not forwarded: Bun would end a child that has no handler', () => {
    const h = harness({ count: 1, role: 'web' });
    h.signal('SIGUSR2');
    expect(h.children[0]?.signals).toEqual([]);
  });
});
