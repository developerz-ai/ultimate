// Which signals start the drain, per platform. Windows never sends SIGTERM: a console close is
// SIGHUP and Ctrl-Break is SIGBREAK, so a Windows process listening for SIGTERM/SIGINT alone was
// killed outright on stop, with no drain. POSIX keeps exactly the pair it always had.

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import {
  configureLifecycle,
  DRAIN_TIMEOUT_EXIT_CODE,
  drain,
  drainExitCode,
  lifecycleState,
  markReady,
  onShutdown,
  type ProcessSignal,
  resetLifecycle,
} from './lifecycle';
import { drainSignals, installSignalHandlers } from './lifecycle-signals';

beforeEach(() => {
  resetLifecycle();
});

afterEach(() => {
  resetLifecycle();
});

const counts = (signals: readonly ProcessSignal[]): number[] =>
  signals.map((signal) => process.listenerCount(signal));

describe('drainSignals', () => {
  test('POSIX drains on SIGTERM and SIGINT, and nothing else', () => {
    expect(drainSignals('linux')).toEqual(['SIGTERM', 'SIGINT']);
    expect(drainSignals('darwin')).toEqual(['SIGTERM', 'SIGINT']);
  });

  test('Windows also drains on console close (SIGHUP) and Ctrl-Break (SIGBREAK)', () => {
    expect(drainSignals('win32')).toEqual(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']);
  });
});

describe('installSignalHandlers', () => {
  const windows: readonly ProcessSignal[] = ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK'];

  test('on win32 it listens for all four, and uninstalling removes every one', () => {
    const before = counts(windows);
    const uninstall = installSignalHandlers({ platform: 'win32' });
    expect(counts(windows)).toEqual(before.map((count) => count + 1));
    uninstall();
    expect(counts(windows)).toEqual(before);
  });

  test('on linux it leaves SIGHUP and SIGBREAK alone', () => {
    const before = counts(['SIGHUP', 'SIGBREAK']);
    const uninstall = installSignalHandlers({ platform: 'linux' });
    expect(counts(['SIGHUP', 'SIGBREAK'])).toEqual(before);
    uninstall();
  });

  test('Ctrl-Break drains, naming the signal it came from', async () => {
    markReady();
    const seen: string[] = [];
    onShutdown('signal-probe', (reason) => {
      seen.push(reason.signal);
    });
    const added = new Set(process.listeners('SIGBREAK'));
    const uninstall = installSignalHandlers({ platform: 'win32' });
    try {
      const handler = process.listeners('SIGBREAK').find((listener) => !added.has(listener));
      if (handler === undefined) return expect.unreachable('no SIGBREAK handler was installed');
      handler('SIGBREAK');
      expect(lifecycleState()).toBe('draining');
      // `drain()` is memoised: this awaits the drain the handler started, it never starts another.
      await drain('SIGTERM');
      expect(lifecycleState()).toBe('stopped');
      expect(seen).toEqual(['SIGBREAK']);
    } finally {
      uninstall();
    }
  });

  test('an explicit signal list wins over the platform default', () => {
    const before = counts(['SIGBREAK']);
    const uninstall = installSignalHandlers({ platform: 'win32', signals: ['SIGTERM'] });
    expect(counts(['SIGBREAK'])).toEqual(before);
    uninstall();
  });
});

/**
 * The exit code is the platform's only record of how a drain went. `0` after a hook was ABANDONED
 * at the deadline told the kubelet, systemd and every exit-code alert that a process whose write
 * may be half done stopped cleanly.
 */
describe('the exit code a drain leaves', () => {
  /** A hook that never returns: the drain abandons it at the deadline, with no wall-clock wait here. */
  const never = (): Promise<void> => new Promise<void>(() => {});

  const run = async (hook: () => Promise<void>): Promise<number | undefined> => {
    configureLifecycle({ deadlineMs: 20, readinessGraceMs: 0 });
    markReady();
    onShutdown('exit-probe', hook, { phase: 'close' });
    const codes: (number | undefined)[] = [];
    const exit = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      codes.push(code);
    }) as typeof process.exit);
    const added = new Set(process.listeners('SIGTERM'));
    const uninstall = installSignalHandlers({ platform: 'linux', exit: true });
    try {
      const handler = process.listeners('SIGTERM').find((listener) => !added.has(listener));
      if (handler === undefined) return expect.unreachable('no SIGTERM handler was installed');
      handler('SIGTERM');
      await drain('SIGTERM');
      // `done` runs on the drain's settle, one turn after the memo resolves.
      await Bun.sleep(0);
      expect(codes).toHaveLength(1);
      return codes[0];
    } finally {
      uninstall();
      exit.mockRestore();
    }
  };

  test('a hook still running at the deadline exits 70, never 0', async () => {
    expect(await run(never)).toBe(70);
    expect(DRAIN_TIMEOUT_EXIT_CODE).toBe(70);
    expect(drainExitCode()).toBe(70);
  });

  test('a clean drain exits 0', async () => {
    expect(await run(async () => {})).toBe(0);
    expect(drainExitCode()).toBe(0);
  });

  test('a reset forgets the last drain', async () => {
    await run(never);
    resetLifecycle();
    expect(drainExitCode()).toBe(0);
  });
});
