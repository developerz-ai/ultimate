// Single responsibility: wiring process signals to the one drain. Split from `lifecycle.ts`, which
// owns the state machine and the phases, when the readiness grace took it past its line ceiling.

import { drain, type ProcessSignal } from './lifecycle';

export interface SignalHandlerOptions {
  readonly signals?: readonly ProcessSignal[] | undefined;
  /** Call `process.exit()` once drained. Off in tests. */
  readonly exit?: boolean | undefined;
}

/** Install SIGTERM/SIGINT handling. Returns an uninstall function. */
export function installSignalHandlers(options?: SignalHandlerOptions): () => void {
  const signals: readonly ProcessSignal[] = options?.signals ?? ['SIGTERM', 'SIGINT'];
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
