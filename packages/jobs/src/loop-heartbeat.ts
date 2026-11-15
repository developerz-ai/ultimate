// Single responsibility: whether a long-running loop is still TURNING, not merely whether its
// process answers. Each loop stamps a heartbeat per pass and per armed wait; a stamp older than a
// declared multiple of the loop's tick — or a pass held open that long — is a wedged loop, and the
// role's liveness route (`packages/cli/src/runtime-liveness.ts`) answers 503 on it.

import { finiteOption } from '@ultimat3/core';
import { IDLE_REST_MAX_MS } from './idle-backoff';

/** How many of its own ticks a loop may go without a stamp before it is wedged. */
export const LIVENESS_TICK_MULTIPLE = 3;

/**
 * The shortest bound any loop gets. Twice the longest rest an idle loop takes (`IDLE_REST_MAX_MS`),
 * so a worker resting on a far due time is never killed for resting, and a pass slowed by a
 * degraded database — statements inside their own bound — is not a restart into the same database.
 */
export const LIVENESS_FLOOR_MS = 2 * IDLE_REST_MAX_MS;

/** A loop's bound: `LIVENESS_TICK_MULTIPLE` ticks, never under `LIVENESS_FLOOR_MS`. */
export const livenessBoundMs = (tickMs: number): number =>
  Math.max(LIVENESS_TICK_MULTIPLE * tickMs, LIVENESS_FLOOR_MS);

export interface LoopHeartbeatOptions {
  /** The longest wait the loop arms between two stamps — its poll ceiling, its status interval. */
  readonly tickMs: number;
  /**
   * `true` (default): a loop on a timer — silence is the wedge. `false`: an event-driven loop
   * (the replicator's change handler) — quiet is health, and only a pass held open is a wedge.
   */
  readonly periodic?: boolean;
  /** Monotonic milliseconds. Default `performance.now()`, which fake timers move with them. */
  readonly now?: () => number;
}

export interface LoopHeartbeat {
  readonly name: string;
  readonly boundMs: number;
  /** Judged from now on, stamped fresh. */
  start(): void;
  /** The loop turned: a pass ended, a wait was armed, a rest slice re-read the wake. */
  stamp(): void;
  /** A pass began; the answer is its end (idempotent). A pass held past the bound is a wedge. */
  enter(): () => void;
  /** No longer judged: a stopped or draining loop is not a wedged one. */
  stop(): void;
}

export interface StaleLoop {
  readonly name: string;
  /** `silent`: no stamp within the bound. `held`: one pass open past it. */
  readonly reason: 'silent' | 'held';
  readonly ageMs: number;
  readonly boundMs: number;
}

interface Judged {
  readonly name: string;
  readonly boundMs: number;
  judge(): StaleLoop | null;
}

/** The loops this process runs, while they run. One set: every role's liveness reads it. */
const running = new Set<Judged>();

export function loopHeartbeat(name: string, options: LoopHeartbeatOptions): LoopHeartbeat {
  const boundMs = livenessBoundMs(finiteOption(`loopHeartbeat(${name})`, 'tickMs', options.tickMs));
  const periodic = options.periodic ?? true;
  const now = options.now ?? (() => performance.now());
  let stampedAt = now();
  /** When each open pass began. */
  const open = new Set<{ readonly at: number }>();

  const judged: Judged = {
    name,
    boundMs,
    judge() {
      const at = now();
      for (const pass of open) {
        if (at - pass.at > boundMs) return { name, reason: 'held', ageMs: at - pass.at, boundMs };
      }
      if (periodic && at - stampedAt > boundMs) {
        return { name, reason: 'silent', ageMs: at - stampedAt, boundMs };
      }
      return null;
    },
  };

  return {
    name,
    boundMs,
    start() {
      stampedAt = now();
      open.clear();
      running.add(judged);
    },
    stamp() {
      stampedAt = now();
    },
    enter() {
      const pass = { at: now() };
      open.add(pass);
      stampedAt = pass.at;
      return () => {
        if (!open.delete(pass)) return;
        stampedAt = now();
      };
    },
    stop() {
      running.delete(judged);
      open.clear();
    },
  };
}

/** Every running loop past its bound, now. Empty is live. */
export function staleLoops(): readonly StaleLoop[] {
  const stale: StaleLoop[] = [];
  for (const loop of running) {
    const verdict = loop.judge();
    if (verdict !== null) stale.push(verdict);
  }
  return stale;
}
