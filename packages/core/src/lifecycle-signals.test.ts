// Which signals start the drain, per platform. Windows never sends SIGTERM: a console close is
// SIGHUP and Ctrl-Break is SIGBREAK, so a Windows process listening for SIGTERM/SIGINT alone was
// killed outright on stop, with no drain. POSIX keeps exactly the pair it always had.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  drain,
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
