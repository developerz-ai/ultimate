// One production container as N child processes on one port: spawn them, restart a crashed one
// with backoff, forward the platform's signals, bound their drain, and answer one exit code. The
// shape is `dev-supervisor.ts`'s — `Bun.spawn` with an `ipc` child — plus what production needs.

import type { Role } from '@ultimat3/core';
import { childShare, logger } from '@ultimat3/core';
import { POOL_MAX_ENV } from '@ultimat3/db';
import { ProcessCrashLoopError } from './supervise-errors';
import type { DrainMessage, DrainSignal } from './supervise-messages';
import { drainMessage, readChildMessage } from './supervise-messages';
import {
  afterCrash,
  aggregateExit,
  CRASH_WINDOW_MS,
  type CrashHistory,
  NO_CRASHES,
} from './supervise-policy';

/** Set on each child: `<index>/<count>` (`supervisedChild` in `@ultimat3/core` reads it). */
export const CHILD_ENV = 'ULTIMATE_CHILD';
/** Past a child's own drain bound, from its `draining` ack, before it is SIGKILLed. */
export const CHILD_DRAIN_SLACK_MS = 2_000;
/** Past the longest bound, from the signal: a CPU-saturated child acks up to 5.2 s late. */
export const OUTER_SLACK_MS = 6_000;
/** A child's loopback `/healthz`, asked this often once it is ready. */
export const HEALTH_POLL_MS = 5_000;
/**
 * Failed polls in a row before a child is restarted by drain: three polls span 10 s, past the
 * 1.9–5.2 s a CPU-saturated child was measured to answer late — busy is not dead.
 */
export const HEALTH_FAILURES = 3;

export interface ChildHandle {
  readonly pid: number;
  /** The exit code, or `null` for a child a signal killed. */
  readonly exited: Promise<number | null>;
  kill(signal: DrainSignal | 'SIGKILL'): void;
  send(message: DrainMessage): void;
}

export type SpawnChild = (input: {
  readonly index: number;
  readonly env: Record<string, string | undefined>;
  readonly onMessage: (message: unknown) => void;
}) => ChildHandle;

export interface SupervisorTimers {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type SignalName = DrainSignal | 'exit';
export interface SignalHub {
  on(signal: SignalName, listener: () => void): void;
  off(signal: SignalName, listener: () => void): void;
}

export type ChildState = 'starting' | 'ready' | 'draining' | 'waiting' | 'exited';

export interface ChildView {
  readonly index: number;
  readonly state: ChildState;
  readonly metricsUrl: string | undefined;
}

export interface SupervisorView {
  children(): readonly ChildView[];
  /** At least one child ready, every other one ready or draining, and the container not stopping. */
  ready(): boolean;
  /** Alive and not giving up on a crash loop. */
  live(): boolean;
}

export interface SuperviseInput {
  readonly count: number;
  readonly role: Role;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The container's pool, split across the children (`childShare`). */
  readonly pool: number;
  /** A child's drain bound until it reports its own (`ready`/`draining`). */
  readonly budgetMs: number;
  readonly spawn?: SpawnChild;
  readonly timers?: SupervisorTimers;
  readonly signals?: SignalHub;
  /** Whether a child's loopback `/healthz` answers 200 (`childHealthy` in `supervise-probe.ts`). */
  readonly healthy?: (metricsUrl: string) => Promise<boolean>;
}

export interface Supervisor {
  readonly view: SupervisorView;
  /** The container's exit code: 0, 70 (a child's drain timed out or was killed), 1 (crash loop). */
  readonly done: Promise<number>;
}

interface Slot {
  readonly index: number;
  state: ChildState;
  child: ChildHandle | undefined;
  metricsUrl: string | undefined;
  budgetMs: number;
  startedAt: number;
  history: CrashHistory;
  timers: unknown[];
  failures: number;
  killed: boolean;
  exit: number | null;
}

const spawnBun: SpawnChild = ({ env, onMessage }) => {
  // A server child has no deadline of its own: its bound is the supervisor's, and a hard kill at
  // that bound is this abort — the drain's ceiling, or a child that would not drain.
  const bound = new AbortController();
  const proc = Bun.spawn([process.execPath, ...process.argv.slice(1)], {
    env,
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
    serialization: 'json',
    ipc: (message) => onMessage(message),
    signal: bound.signal,
    killSignal: 'SIGKILL',
  });
  return {
    pid: proc.pid,
    exited: proc.exited.then(() => (proc.signalCode === null ? proc.exitCode : null)),
    kill: (signal) => (signal === 'SIGKILL' ? bound.abort() : proc.kill(signal)),
    send: (message) => {
      proc.send(message);
    },
  };
};

const realTimers: SupervisorTimers = {
  now: () => performance.now(),
  setTimeout: (run, ms) => setTimeout(run, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

const processSignals: SignalHub = {
  on: (signal, listener) => process.on(signal, listener),
  off: (signal, listener) => process.off(signal, listener),
};

const say = (level: 'info' | 'warn' | 'error', msg: string, fields: Record<string, unknown>) =>
  logger[level](msg, { child: 'supervisor', ...fields });

export function supervise(input: SuperviseInput): Supervisor {
  const spawn = input.spawn ?? spawnBun;
  const timers = input.timers ?? realTimers;
  const signals = input.signals ?? processSignals;
  const slots: Slot[] = Array.from({ length: input.count }, (_, index) => ({
    index,
    state: 'waiting',
    child: undefined,
    metricsUrl: undefined,
    budgetMs: input.budgetMs,
    startedAt: 0,
    history: NO_CRASHES,
    timers: [],
    failures: 0,
    killed: false,
    exit: null,
  }));
  let stopping: DrainSignal | undefined;
  let ceiling: unknown;
  let killedAtCeiling = false;
  let failure: ProcessCrashLoopError | 'fatal' | undefined;
  let finished = false;
  let resolve!: (code: number) => void;
  const done = new Promise<number>((settle) => {
    resolve = settle;
  });

  // Only PENDING handles stay on the slot: a fired one leaves it, or a healthy child's polls
  // (one per HEALTH_POLL_MS) would pile up until its next exit.
  const later = (slot: Slot, ms: number, run: () => void): void => {
    const handle = timers.setTimeout(() => {
      const at = slot.timers.indexOf(handle);
      if (at !== -1) slot.timers.splice(at, 1);
      run();
    }, ms);
    slot.timers.push(handle);
  };
  const clear = (slot: Slot): void => {
    for (const handle of slot.timers.splice(0)) timers.clearTimeout(handle);
  };

  /** Once per child: both bounds can land on one tick. Only a stop's kill makes the exit 70. */
  const killHard = (slot: Slot, msg: string): void => {
    if (slot.child === undefined || slot.killed) return;
    slot.killed = true;
    if (stopping !== undefined) killedAtCeiling = true;
    say('warn', msg, { index: slot.index });
    slot.child.kill('SIGKILL');
  };

  const finishIfGone = (): void => {
    if (finished || stopping === undefined || slots.some((slot) => slot.child !== undefined))
      return;
    finished = true;
    for (const [signal, listener] of handlers) signals.off(signal, listener);
    timers.clearTimeout(ceiling);
    const code =
      failure !== undefined
        ? 1
        : aggregateExit(
            slots.map((slot) => slot.exit),
            killedAtCeiling,
          );
    say(code === 0 ? 'info' : 'warn', 'ultimate processes stopped', { code });
    resolve(code);
  };

  /**
   * One stop per container. A retire (SIGUSR2, worker only) may be followed by the platform's
   * SIGTERM, which is forwarded and arms the ceiling; anything after that is the same stop.
   */
  const stop = (signal: DrainSignal): void => {
    const upgrade = stopping === 'SIGUSR2' && signal !== 'SIGUSR2';
    if (stopping !== undefined && !upgrade) return;
    stopping = signal;
    for (const slot of slots) {
      if (slot.child === undefined) {
        clear(slot);
        slot.state = 'exited';
        continue;
      }
      slot.child.kill(signal);
    }
    // A retire (SIGUSR2) is bounded by the platform's own kill timer; a stop by ours.
    if (signal !== 'SIGUSR2') {
      const longest = Math.max(input.budgetMs, ...slots.map((slot) => slot.budgetMs));
      ceiling = timers.setTimeout(() => {
        for (const slot of slots) killHard(slot, 'ultimate child killed at the drain ceiling');
      }, longest + OUTER_SLACK_MS);
    }
    finishIfGone();
  };

  const onMessage = (slot: Slot, raw: unknown): void => {
    const message = readChildMessage(raw);
    if (message === undefined) return;
    if (message.event === 'ready') {
      if (slot.state === 'starting') slot.state = 'ready';
      slot.metricsUrl = message.metricsUrl;
      slot.budgetMs = message.budgetMs;
      return;
    }
    if (message.event === 'draining') {
      slot.state = 'draining';
      slot.budgetMs = message.budgetMs;
      // The child's own bound starts at its ack: a saturated child hears the signal seconds late.
      later(slot, message.budgetMs + CHILD_DRAIN_SLACK_MS, () =>
        killHard(slot, 'ultimate child killed past its drain bound'),
      );
      return;
    }
    if (message.event === 'fatal') {
      failure = 'fatal';
      say('error', 'ultimate child refused to serve', { index: slot.index, code: message.code });
      stop('SIGTERM');
    }
  };

  const onExit = (slot: Slot, code: number | null): void => {
    clear(slot);
    slot.child = undefined;
    slot.metricsUrl = undefined;
    slot.exit = code;
    if (stopping !== undefined) {
      slot.state = 'exited';
      finishIfGone();
      return;
    }
    const now = timers.now();
    const decision = afterCrash(slot.history, now, now - slot.startedAt);
    slot.history = decision.history;
    if (decision.loop) {
      const error = new ProcessCrashLoopError({
        index: slot.index,
        code,
        crashes: decision.history.at.length,
        windowMs: CRASH_WINDOW_MS,
      });
      failure = error;
      say('error', error.code, { code: error.code, cause: error.cause, fix: error.fix });
      stop('SIGTERM');
      return;
    }
    slot.state = 'waiting';
    say('warn', 'ultimate child exited', {
      index: slot.index,
      exitCode: code,
      restartInMs: decision.delayMs,
    });
    later(slot, decision.delayMs, () => start(slot));
  };

  const poll = (slot: Slot, child: ChildHandle): void => {
    later(slot, HEALTH_POLL_MS, () => {
      if (slot.child !== child || stopping !== undefined) return;
      const url = slot.metricsUrl;
      if (slot.state !== 'ready' || url === undefined || input.healthy === undefined) {
        poll(slot, child);
        return;
      }
      void input.healthy(url).then((ok) => {
        if (slot.child !== child) return;
        slot.failures = ok ? 0 : slot.failures + 1;
        if (slot.failures >= HEALTH_FAILURES) {
          say('warn', 'ultimate child unhealthy, restarting it', { index: slot.index });
          slot.state = 'draining';
          child.send(drainMessage('SIGTERM'));
          // A child too wedged to ack is bounded as a stop is: its exit is then restarted.
          later(slot, slot.budgetMs + OUTER_SLACK_MS, () =>
            killHard(slot, 'ultimate child killed: it did not drain after failing its health'),
          );
          return;
        }
        poll(slot, child);
      });
    });
  };

  const start = (slot: Slot): void => {
    if (stopping !== undefined) return;
    const child = spawn({
      index: slot.index,
      env: {
        ...input.env,
        [CHILD_ENV]: `${String(slot.index)}/${String(input.count)}`,
        [POOL_MAX_ENV]: String(childShare(input.pool, slot.index, input.count)),
      },
      onMessage: (message) => onMessage(slot, message),
    });
    slot.child = child;
    slot.state = 'starting';
    slot.startedAt = timers.now();
    slot.failures = 0;
    slot.killed = false;
    void child.exited.then((code) => {
      if (slot.child === child) onExit(slot, code);
    });
    if (input.healthy !== undefined) poll(slot, child);
  };

  // Before the first spawn: Bun as PID 1 IGNORES a SIGTERM nobody handles (measured), and a
  // signal landing between two spawns must still reach the child already running.
  const handlers: [SignalName, () => void][] = [
    ['SIGTERM', () => stop('SIGTERM')],
    ['SIGINT', () => stop('SIGINT')],
    ['SIGUSR2', () => (input.role === 'worker' ? stop('SIGUSR2') : undefined)],
    // An uncaught throw here: each child is asked to drain (a SIGKILL of this process is answered
    // by the children themselves, on IPC disconnect — `supervise-child.ts`).
    [
      'exit',
      () => {
        for (const slot of slots) slot.child?.kill('SIGTERM');
      },
    ],
  ];
  for (const [signal, listener] of handlers) signals.on(signal, listener);
  say('info', 'ultimate processes starting', { count: input.count, role: input.role });
  for (const slot of slots) start(slot);

  return {
    done,
    view: {
      children: () =>
        slots.map((slot) => ({
          index: slot.index,
          state: slot.state,
          metricsUrl: slot.metricsUrl,
        })),
      ready: () =>
        stopping === undefined &&
        slots.some((slot) => slot.state === 'ready') &&
        slots.every((slot) => slot.state === 'ready' || slot.state === 'draining'),
      live: () => !(failure instanceof ProcessCrashLoopError),
    },
  };
}
