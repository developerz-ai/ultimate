// `runSupervised` in-process, over fake children: the container's probe is open on `METRICS_PORT`
// before any child is ready, each child is started as `ROLE` with its share of the pool, `/readyz`
// follows the children, and a SIGTERM drains them to the container's exit code and closes the probe.

import { describe, expect, test } from 'bun:test';
import { allowHost, bindFreePorts } from '@ultimat3/testing';
import type { ChildHandle, SignalHub, SignalName } from './supervise';
import { runSupervised } from './supervise-run';

interface FakeChild extends ChildHandle {
  readonly env: Record<string, string | undefined>;
  readonly signals: string[];
  say(message: unknown): void;
  exit(code: number): void;
}

const status = (port: number, path: string): Promise<number> =>
  fetch(`http://127.0.0.1:${String(port)}${path}`).then(
    (response) => response.status,
    () => 0,
  );

describe('unit · runSupervised', () => {
  test('probe first, a pool share per child, /readyz follows them, SIGTERM drains to 0', async () => {
    const children: FakeChild[] = [];
    const listeners = new Map<SignalName, () => void>();
    const signals: SignalHub = {
      on: (signal, listener) => listeners.set(signal, listener),
      off: (signal) => listeners.delete(signal),
    };
    const { port, done } = await bindFreePorts(async ([metricsPort = 0]) => {
      allowHost(`127.0.0.1:${String(metricsPort)}`);
      const exitCode = runSupervised(
        {
          root: '/nonexistent-supervise-run',
          env: { NODE_ENV: 'production' },
          port: 0,
          metricsPort,
          hostname: '127.0.0.1',
        },
        'web',
        2,
        {
          signals,
          spawn: ({ env, onMessage }) => {
            let exit!: (code: number) => void;
            const exited = new Promise<number | null>((resolve) => {
              exit = resolve;
            });
            const child: FakeChild = {
              env,
              pid: 2000 + children.length,
              exited,
              signals: [],
              kill(signal) {
                this.signals.push(signal);
              },
              send: () => undefined,
              say: onMessage,
              exit,
            };
            children.push(child);
            return child;
          },
        },
      );
      // The probe answers before any child said ready: not ready, never refused.
      expect(await status(metricsPort, '/readyz')).toBe(503);
      return { port: metricsPort, done: exitCode };
    });

    expect(children.map((child) => [child.env['ROLE'], child.env['DATABASE_POOL_MAX']])).toEqual([
      ['web', '10'],
      ['web', '10'],
    ]);
    expect(await status(port, '/healthz')).toBe(200);
    for (const child of children) {
      child.say({ type: 'x-proc', event: 'ready', metricsUrl: 'http://127.0.0.1:1', budgetMs: 50 });
    }
    expect(await status(port, '/readyz')).toBe(200);

    listeners.get('SIGTERM')?.();
    // Docker signals PID 1 only: the supervisor passes it on to every child.
    expect(children.map((child) => child.signals)).toEqual([['SIGTERM'], ['SIGTERM']]);
    for (const child of children) child.exit(0);
    expect(await done).toBe(0);
    // The container's probe goes with the supervisor.
    expect(await status(port, '/healthz')).toBe(0);
  });
});
