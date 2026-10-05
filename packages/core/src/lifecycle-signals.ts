// Single responsibility: wiring process signals to the one drain. Split from `lifecycle.ts`, which
// owns the state machine and the phases, when the readiness grace took it past its line ceiling.

import { drain, type ProcessSignal } from './lifecycle';

export interface SignalHandlerOptions {
  readonly signals?: readonly ProcessSignal[] | undefined;
  /** Call `process.exit()` once drained. Off in tests. */
  readonly exit?: boolean | undefined;
  /** Whose default signal set to install — `process.platform` unless a test names one. */
  readonly platform?: string | undefined;
}

const POSIX_SIGNALS: readonly ProcessSignal[] = Object.freeze(['SIGTERM', 'SIGINT']);

/**
 * Windows never sends SIGTERM to a console process: a service stop or a closed console window
 * arrives as SIGHUP, and Ctrl-Break as SIGBREAK. Listening for the POSIX pair alone meant either
 * one killed the process outright, mid-request, with no drain. SIGHUP stays off POSIX on purpose:
 * there it is a terminal hang-up a supervised process should not read as "stop".
 */
const WINDOWS_SIGNALS: readonly ProcessSignal[] = Object.freeze([
  'SIGTERM',
  'SIGINT',
  'SIGHUP',
  'SIGBREAK',
]);

/** The signals that start a drain on `platform`. */
export function drainSignals(platform: string = process.platform): readonly ProcessSignal[] {
  return platform === 'win32' ? WINDOWS_SIGNALS : POSIX_SIGNALS;
}

/**
 * Install drain-on-signal handling — SIGTERM/SIGINT, plus SIGHUP/SIGBREAK on Windows
 * (`drainSignals`). Returns an uninstall function.
 */
export function installSignalHandlers(options?: SignalHandlerOptions): () => void {
  const signals = options?.signals ?? drainSignals(options?.platform);
  const handlers = new Map<ProcessSignal, () => void>();

  for (const signal of signals) {
    const handler = (): void => {
      // Attached on BOTH settle paths, for the reason `settleWithin` gives: an unhandled rejection
      // ends the process before the drain does, and the exit is what the kubelet is waiting for.
      // `drain()` cannot reject today — that is `runDrain`'s `try/finally` in `lifecycle.ts`, not luck — and this is
      // the one line that keeps it true when someone changes the body.
      const done = (): void => {
        if (options?.exit === true) process.exit(0);
      };
      void drain(signal).then(done, done);
    };
    handlers.set(signal, handler);
    process.on(signal, handler);
  }

  return () => {
    for (const [signal, handler] of handlers) process.off(signal, handler);
  };
}
