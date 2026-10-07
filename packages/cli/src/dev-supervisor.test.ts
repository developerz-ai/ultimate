// Which `x` invocations are supervised, the child argv they run, and the respawn loop — with a
// fake child, so no process is started. The real two-process restart is
// `cmd-dev-restart.live.test.ts`.

import { describe, expect, test } from 'bun:test';
import type { DevChild } from './dev-supervisor';
import {
  childRestart,
  DEV_CHILD_ENV,
  DEV_RESTART_EXIT_CODE,
  devSupervision,
  freeDevPort,
  restartFinding,
  restartReason,
  stopChild,
  superviseDev,
} from './dev-supervisor';

const pick = (): number => 4242;

describe('unit · devSupervision', () => {
  test('`x dev` is supervised with its argv as typed', () => {
    expect(devSupervision(['dev', '--port', '3001'], {}, pick)).toEqual({
      argv: ['dev', '--port', '3001'],
    });
  });

  test('`--port 0` is pinned to one free port, so a restarted child binds the same one', () => {
    expect(devSupervision(['dev', '--port', '0', '--json'], {}, pick)?.argv).toEqual([
      'dev',
      '--json',
      '--port',
      '4242',
    ]);
    expect(devSupervision(['dev', '--port=0'], {}, pick)?.argv).toEqual(['dev', '--port', '4242']);
    expect(devSupervision(['dev'], { PORT: '0' }, pick)?.argv).toEqual(['dev', '--port', '4242']);
  });

  test('never the child, `--once`, `--help`, another command, or an argv the parse refuses', () => {
    expect(devSupervision(['dev'], { [DEV_CHILD_ENV]: '1' }, pick)).toBeUndefined();
    expect(devSupervision(['dev', '--once'], {}, pick)).toBeUndefined();
    expect(devSupervision(['dev', '--help'], {}, pick)).toBeUndefined();
    expect(devSupervision(['build'], {}, pick)).toBeUndefined();
    expect(devSupervision(['dev', '--bogus'], {}, pick)).toBeUndefined();
  });
});

const fakeChildren = (codes: readonly number[]) => {
  const spawned: { command: readonly string[]; env: Record<string, string | undefined> }[] = [];
  const spawn = (command: readonly string[], env: Record<string, string | undefined>): DevChild => {
    spawned.push({ command, env });
    const code = codes[spawned.length - 1] ?? 0;
    return { exited: Promise.resolve(code), kill: () => undefined };
  };
  return { spawned, spawn };
};

describe('unit · freeDevPort picks a free PAIR', () => {
  test('a candidate whose neighbour is taken is skipped: x dev binds port and port + 1', () => {
    const candidates = [20_904, 31_000];
    const taken = new Set([20_905]);
    expect(
      freeDevPort(
        () => candidates.shift() ?? 0,
        (port) => !taken.has(port),
      ),
    ).toBe(31_000);
  });

  test('the top of the range is never a candidate: its neighbour is not a port', () => {
    const candidates = [65_535, 40_000];
    expect(
      freeDevPort(
        () => candidates.shift() ?? 0,
        () => true,
      ),
    ).toBe(40_000);
  });

  test('a real call answers a port whose neighbour binds', () => {
    const port = freeDevPort();
    expect(port).toBeGreaterThan(0);
    const pair = Bun.serve({ port: port + 1, fetch: () => new Response() });
    pair.stop(true);
  });
});

describe('unit · superviseDev', () => {
  test('a restart exit boots the next child with the same argv; any other code is the answer', async () => {
    const { spawned, spawn } = fakeChildren([DEV_RESTART_EXIT_CODE, DEV_RESTART_EXIT_CODE, 3]);
    const code = await superviseDev({
      bin: '/x/bin.ts',
      argv: ['dev', '--port', '1'],
      env: {},
      spawn,
    });
    expect(code).toBe(3);
    expect(spawned).toHaveLength(3);
    expect(spawned[2]?.command.slice(1)).toEqual(['/x/bin.ts', 'dev', '--port', '1']);
    expect(spawned.every((child) => child.env[DEV_CHILD_ENV] === '1')).toBe(true);
  });

  test('its signal handlers are removed once the last child exits', async () => {
    const before = process.listenerCount('SIGINT');
    const { spawn } = fakeChildren([0]);
    await superviseDev({ bin: '/x/bin.ts', argv: ['dev'], env: {}, spawn });
    expect(process.listenerCount('SIGINT')).toBe(before);
  });
});

describe('unit · the restart line and finding', () => {
  const pins = [
    { changed: '/app/apps/web/app/greet/service.ts', pinned: '/app/apps/web/app/greet/queries.ts' },
    { changed: '/app/apps/web/app/notes/entity.ts', pinned: '/app/apps/web/app/notes/entity.ts' },
  ];

  test('names each save under the module that holds it, root-relative', () => {
    expect(restartReason('/app', pins)).toBe(
      'apps/web/app/greet/service.ts under apps/web/app/greet/queries.ts, apps/web/app/notes/entity.ts',
    );
  });

  test('unsupervised, it is X_DEV_RESTART_REQUIRED at the first pinned module', () => {
    const finding = restartFinding('/app', pins);
    expect(finding.code).toBe('X_DEV_RESTART_REQUIRED');
    expect(finding.at).toBe('apps/web/app/greet/queries.ts');
    expect(finding.fix).toContain('restart x dev');
  });
});

describe('unit · childRestart', () => {
  test('only a supervised child restarts; anything else keeps the /_x finding', () => {
    const plain = childRestart('/app', {});
    expect(plain.options.onRestart).toBeUndefined();
    // Never exits a process nothing supervises, whatever the hold hands it.
    plain.exit(0);
    expect(childRestart('/app', { [DEV_CHILD_ENV]: '1' }).options.onRestart).toBeFunction();
  });

  // Issue #677: the restart retires the worker this child booted before anything drains, and a
  // second save landing while it waits joins that restart rather than starting another.
  test('a restart retires the adopted worker, once however many saves land', () => {
    const retired: unknown[] = [];
    const restart = childRestart('/app', { [DEV_CHILD_ENV]: '1' }, undefined, (worker) => {
      retired.push(worker);
      return new Promise<void>(() => undefined);
    });
    const worker = { stats: () => Promise.reject(), stop: () => Promise.resolve() };
    restart.adopt(worker);
    restart.options.onRestart?.([]);
    restart.options.onRestart?.([]);
    expect(retired).toEqual([worker]);
  });
});

describe('unit · stopChild', () => {
  const child = (send?: (message: unknown) => void) => {
    const killed: string[] = [];
    const sent: unknown[] = [];
    return {
      killed,
      sent,
      child: {
        exited: new Promise<number>(() => undefined),
        kill: (signal: string) => killed.push(signal),
        ...(send === undefined
          ? {}
          : {
              send: (message: unknown) => {
                send(message);
                sent.push(message);
              },
            }),
      },
    };
  };

  test('a stop is a drain message over IPC, never a signal — on Windows a signal kills outright', () => {
    const one = child(() => undefined);
    stopChild(one.child, 'SIGTERM');
    expect(one.sent).toEqual([{ type: 'x-dev-drain', signal: 'SIGTERM' }]);
    expect(one.killed).toEqual([]);
  });

  test('no channel, or a closed one, falls back to the signal', () => {
    const none = child();
    stopChild(none.child, 'SIGINT');
    expect(none.killed).toEqual(['SIGINT']);
    // Input, not a verdict: the error a closed channel's `send` raises.
    const closedChannel = new TypeError('channel closed');
    const closed = child(() => {
      throw closedChannel;
    });
    stopChild(closed.child, 'SIGTERM');
    expect(closed.killed).toEqual(['SIGTERM']);
  });

  test('a message nobody acted on is followed by the signal once the bound has passed', async () => {
    const booting = child(() => undefined);
    stopChild(booting.child, 'SIGTERM', 5);
    expect(booting.killed).toEqual([]);
    await Bun.sleep(30);
    expect(booting.killed).toEqual(['SIGTERM']);
  });
});
