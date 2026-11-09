// Single responsibility: noticing a statement nobody answered, pooled or on a pin. `statement_timeout`
// is the server's, so it cannot fire when the server or the path is gone, and the kernel's retransmit
// window is about 15 minutes. One timer per pool walks the statements in flight; none arms its own.

import type { Scheduler } from '@ultimat3/core';
import { statementUnanswered } from './errors';
import { unrefSchedule } from './pool-timer';
import { statementExcerpt } from './statement-excerpt';

/** Past `statementTimeoutMs` plus this, the server's own bound had to have answered. */
export const UNANSWERED_GRACE_MS = 5_000;
export const SWEEP_INTERVAL_MS = 1_000;

export interface PoolSweepOptions<Owner> {
  /** `statementTimeoutMs + UNANSWERED_GRACE_MS`. The caller skips the sweep when the role has none. */
  readonly deadlineMs: number;
  /** A statement on `owner` missed. Called before its caller hears, so a retry finds the new pool. */
  readonly onMiss: (owner: Owner, excerpt: string, waitedMs: number) => void;
  readonly schedule?: Scheduler | undefined;
}

export interface PoolSweep<Owner> {
  /**
   * `sending`'s answer, or `X_DB_UNAVAILABLE` once it is past the deadline: the pool's, or
   * `deadlineMs` for a pin whose own bound moved (`pool-pins.ts`). `0` judges nothing.
   */
  track<T>(owner: Owner, text: string, sending: Promise<T>, deadlineMs?: number): Promise<T>;
}

interface InFlight<Owner> {
  readonly owner: Owner;
  readonly text: string;
  readonly startedAtTick: number;
  readonly deadlineMs: number;
  readonly ticksToMiss: number;
  readonly reject: (reason: unknown) => void;
}

/**
 * Age is counted in ticks that FIRED, never read from a clock. A tick reads no clock at all, and
 * the count is also the right answer to a frozen process: a long GC or a SIGSTOP costs one tick however long it lasted, so answers sitting
 * unread in their sockets are never judged late. A statement began somewhere inside its first tick,
 * hence the extra one: nothing is judged before the deadline, and everything within one interval of it.
 */
export function poolSweep<Owner>(options: PoolSweepOptions<Owner>): PoolSweep<Owner> {
  const schedule = options.schedule ?? unrefSchedule;
  const ticksFor = (deadlineMs: number): number => Math.ceil(deadlineMs / SWEEP_INTERVAL_MS) + 1;
  const ticksToMiss = ticksFor(options.deadlineMs);
  // Insertion order is start order and every statement has the same deadline, so a walk stops at
  // the first one still in time, whatever the pool's size.
  const inFlight = new Set<InFlight<Owner>>();
  // Each its own deadline, so walked whole: at most one per pin, and pins are at most `max`.
  const ownDeadline = new Set<InFlight<Owner>>();
  let ticks = 0;
  let armed = false;

  function arm(): void {
    armed = true;
    schedule(tick, SWEEP_INTERVAL_MS);
  }

  function tick(): void {
    armed = false;
    ticks += 1;
    for (const entry of inFlight) {
      if (ticks - entry.startedAtTick < ticksToMiss) break;
      miss(inFlight, entry);
    }
    for (const entry of ownDeadline) {
      if (ticks - entry.startedAtTick >= entry.ticksToMiss) miss(ownDeadline, entry);
    }
    if (inFlight.size > 0 || ownDeadline.size > 0) arm();
  }

  function miss(from: Set<InFlight<Owner>>, entry: InFlight<Owner>): void {
    from.delete(entry);
    const excerpt = statementExcerpt(entry.text);
    options.onMiss(entry.owner, excerpt, (ticks - entry.startedAtTick) * SWEEP_INTERVAL_MS);
    entry.reject(statementUnanswered(excerpt, entry.deadlineMs));
  }

  return {
    track<T>(owner: Owner, text: string, sending: Promise<T>, deadlineMs?: number): Promise<T> {
      if (deadlineMs === 0) return sending;
      const own = deadlineMs !== undefined && deadlineMs !== options.deadlineMs;
      const bound = own ? deadlineMs : options.deadlineMs;
      const into = own ? ownDeadline : inFlight;
      return new Promise<T>((resolve, reject) => {
        const entry: InFlight<Owner> = {
          owner,
          text,
          startedAtTick: ticks,
          deadlineMs: bound,
          ticksToMiss: own ? ticksFor(bound) : ticksToMiss,
          reject,
        };
        into.add(entry);
        if (!armed) arm();
        // Both arms stay attached after a miss: the statement rejects when its pool closes, and
        // nobody else is left holding that promise.
        sending.then(
          (value) => {
            into.delete(entry);
            resolve(value);
          },
          (error: unknown) => {
            into.delete(entry);
            reject(error);
          },
        );
      });
    },
  };
}
