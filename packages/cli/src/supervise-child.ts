// A supervised child's half of the link: say `ready` once booted and bound, acknowledge a drain
// the moment its handler runs, drain on the supervisor's message, and leave when the supervisor
// is gone — IPC `disconnect` first, a poll of the ORIGINAL ppid behind it (an orphan is re-parented
// to the nearest subreaper, not to pid 1: measured), so a SIGKILLed supervisor leaves no orphan.

import {
  DRAIN_TIMEOUT_EXIT_CODE,
  drain,
  drainDeadlineMs,
  logger,
  readinessGraceMs,
  supervisedChild,
} from '@ultimat3/core';
import type { ChildMessage, DrainSignal } from './supervise-messages';
import { PROCESS_MESSAGE_TYPE, readDrainMessage } from './supervise-messages';

/** How often the ppid is asked; `disconnect` usually answers first (~20 ms, measured). */
export const PARENT_POLL_MS = 1_000;
/** Past its own drain bound, a child whose supervisor is gone exits whatever the drain did. */
export const ORPHAN_EXIT_SLACK_MS = 2_000;

type Release = () => void;

/** Every process seam the link touches, injected so a test drives it without a second process. */
export interface ChildLinkHost {
  send(message: ChildMessage): void;
  onMessage(listener: (message: unknown) => void): Release;
  onDisconnect(listener: () => void): Release;
  onSignal(signal: DrainSignal, listener: () => void): Release;
  /** Delivers `signal` to this process, so a drain by message takes the signal's own path. */
  raise(signal: DrainSignal): void;
  ppid(): number;
  every(ms: number, run: () => void): Release;
  /** A timer that is NOT unref'd: the one that must still fire when everything else is stuck. */
  after(ms: number, run: () => void): void;
  drain(reason: string): Promise<void>;
  exit(code: number): void;
  budgetMs(): number;
}

const processHost: ChildLinkHost = {
  send: (message) => {
    try {
      process.send?.(message);
    } catch {
      // The channel closed under us: the supervisor is gone, and `disconnect` says so.
    }
  },
  onMessage: (listener) => {
    process.on('message', listener);
    return () => process.off('message', listener);
  },
  onDisconnect: (listener) => {
    process.on('disconnect', listener);
    return () => process.off('disconnect', listener);
  },
  onSignal: (signal, listener) => {
    process.on(signal, listener);
    return () => process.off(signal, listener);
  },
  raise: (signal) => process.kill(process.pid, signal),
  ppid: () => process.ppid,
  every: (ms, run) => {
    const timer = setInterval(run, ms);
    // Never what keeps a child alive: its hold is.
    timer.unref();
    return () => clearInterval(timer);
  },
  after: (ms, run) => {
    setTimeout(run, ms);
  },
  drain,
  exit: (code) => process.exit(code),
  // What core's drain is bounded by: the readiness grace runs first, outside the deadline.
  budgetMs: () => readinessGraceMs() + drainDeadlineMs(),
};

export interface ChildLink {
  readonly index: number;
  readonly count: number;
  /** Booted, and the shared port bound: `metricsUrl` is this child's loopback scrape base. */
  ready(metricsUrl: string): void;
  /** Leaving with `code` — said before the exit, which the supervisor reads anyway. */
  gone(code: number): void;
  /** A refusal no restart can fix: the supervisor stops restarting and the container exits 1. */
  fatal(code: string): void;
  release(): void;
}

/** `undefined` for a process no supervisor started (`ULTIMATE_CHILD` unset). */
export function linkToSupervisor(
  env: Readonly<Record<string, string | undefined>>,
  host: ChildLinkHost = processHost,
): ChildLink | undefined {
  const place = supervisedChild(env);
  if (place === undefined) return undefined;
  const originalPpid = host.ppid();
  let acked = false;
  let orphaned = false;
  const ack = (): void => {
    if (acked) return;
    acked = true;
    host.send({ type: PROCESS_MESSAGE_TYPE, event: 'draining', budgetMs: host.budgetMs() });
  };
  const orphan = (why: string): void => {
    if (orphaned) return;
    orphaned = true;
    logger.warn('ultimate supervisor gone', {
      cause: `${why}, so this child drains and exits rather than serve with nobody to restart or stop it`,
    });
    host.after(host.budgetMs() + ORPHAN_EXIT_SLACK_MS, () => host.exit(DRAIN_TIMEOUT_EXIT_CODE));
    void host.drain('supervisor-gone');
  };
  const releases: Release[] = [
    // Beside core's own handlers, never instead of them: the drain is theirs, the ack is this.
    ...(['SIGTERM', 'SIGINT', 'SIGUSR2'] as const).map((signal) => host.onSignal(signal, ack)),
    host.onMessage((message) => {
      const asked = readDrainMessage(message);
      if (asked !== undefined) host.raise(asked.signal);
    }),
    host.onDisconnect(() => orphan('the supervisor closed its IPC channel')),
    host.every(PARENT_POLL_MS, () => {
      if (host.ppid() !== originalPpid) orphan('this child was re-parented');
    }),
  ];
  return {
    index: place.index,
    count: place.count,
    ready: (metricsUrl) =>
      host.send({
        type: PROCESS_MESSAGE_TYPE,
        event: 'ready',
        metricsUrl,
        budgetMs: host.budgetMs(),
      }),
    gone: (code) => host.send({ type: PROCESS_MESSAGE_TYPE, event: 'gone', code }),
    fatal: (code) => host.send({ type: PROCESS_MESSAGE_TYPE, event: 'fatal', code }),
    release: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}
