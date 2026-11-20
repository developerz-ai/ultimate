// A supervised child's half of the link: say `ready` once booted and bound, acknowledge a drain
// the moment its handler runs, drain on the supervisor's message, and leave when the supervisor
// is gone — IPC `disconnect` first, a poll of the ORIGINAL ppid behind it (an orphan is re-parented
// to the nearest subreaper, not to pid 1: measured), so a SIGKILLed supervisor leaves no orphan.

import {
  DRAIN_TIMEOUT_EXIT_CODE,
  drain,
  drainDeadlineMs,
  isUltimateError,
  logger,
  readinessGraceMs,
  renderThrowable,
  supervisedChild,
} from '@ultimat3/core';
import type { ChildMessage, DrainSignal } from './supervise-messages';
import { PROCESS_MESSAGE_TYPE, readDrainMessage } from './supervise-messages';

/** How often the ppid is asked; `disconnect` usually answers first (~20 ms, measured). */
export const PARENT_POLL_MS = 1_000;
/** Past its own drain bound, a child whose supervisor is gone exits whatever the drain did. */
export const ORPHAN_EXIT_SLACK_MS = 2_000;

type Release = () => void;

/**
 * Boot refusals that are a function of the image and its environment alone: a restart of the same
 * child meets each again, unchanged, so the supervisor stops at the first and the container exits 1
 * with the child's own code and fix. Never what can heal by itself while the child waits — a
 * database, Redis or NATS still starting, migrations the migrate job has not applied yet
 * (`X_APP_MIGRATIONS_UNAPPLIED`, `X_FRAMEWORK_SCHEMA_UNAPPLIED`), a port still held, a pool
 * timeout — nor state outside the image (`X_DB_ROW_SECURITY_BYPASSED`: a grant;
 * `X_SEAL_KEY_UNKNOWN`: rows), nor `X_APP_MODULE_LOAD_FAILED`, which wraps whatever an app module
 * threw at import.
 */
export const FATAL_BOOT_CODES: ReadonlySet<string> = new Set([
  // The environment: a required variable missing or malformed, a value no deploy names.
  'X_ENV_MISSING',
  'X_ROLE_UNKNOWN',
  'X_ROLE_INVALID',
  'X_ENVIRONMENT_INVALID',
  'X_PORT_INVALID',
  'X_CURSOR_SECRET_DEV',
  // `app.config.ts`, the TLS pair, a role the config does not list, a database a newer major
  // stamped.
  'X_CONFIG_INVALID',
  // The committed secrets against the key the environment holds.
  'X_SEAL_KEY_MISSING',
  'X_SECRETS_KEY_MISSING',
  'X_SECRETS_KEY_INVALID',
  'X_SECRETS_KEY_MISMATCH',
  'X_SECRETS_FILE_INVALID',
  'X_SECRETS_TAMPERED',
  // What the image holds: an import that resolves nowhere, an app that registers nothing, a role
  // missing what the manifest names, a queue, disk or store the app never declared.
  'X_APP_IMPORT_UNRESOLVED',
  'X_APP_EMPTY',
  'X_ROLE_LOAD_INCOMPLETE',
  'X_WORKER_QUEUE_UNKNOWN',
  'X_STORAGE_DISK_UNKNOWN',
  'X_IDEMPOTENCY_NOT_SHARED',
  'X_NOTIFY_STORE_MISSING',
  // The count itself and per-process state under it.
  'X_PROCESSES_INVALID',
  'X_PROCESSES_ROLE_SINGLETON',
  'X_PROCESSES_UNSHARED_STATE',
  'X_PROCESSES_OVER_POOL',
  'X_PROCESSES_UNBALANCED',
]);

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
  /**
   * The boot threw: one `error` line through the logger, so it carries this child's index (Bun's
   * own print of the uncaught throw names none, and the crash loop's fix points at this line);
   * `fatal` too when it is a refusal only a redeploy changes (`FATAL_BOOT_CODES`).
   */
  refused(error: unknown): void;
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
    refused: (error) => {
      logger.error(
        'ultimate child refused to boot',
        isUltimateError(error)
          ? { code: error.code, cause: error.cause, fix: error.fix }
          : { cause: renderThrowable(error) },
      );
      if (isUltimateError(error) && FATAL_BOOT_CODES.has(error.code)) {
        host.send({ type: PROCESS_MESSAGE_TYPE, event: 'fatal', code: error.code });
      }
    },
    release: () => {
      for (const release of releases.splice(0)) release();
    },
  };
}
