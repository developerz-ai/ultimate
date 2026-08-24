/**
 * The audit seam's process-memory sink: a bounded ring that DROPS, for tests and `x dev`. Split
 * from `audit.ts` on the seam `idempotency.ts` / `idempotency-memory.ts` already draw, so the file
 * declaring what a record IS is not also the file deciding how many are kept.
 */

import type { AuditRecord, AuditSink } from './audit';

/**
 * Records held at once. A record pins a whole `Ctx` — the actor, the service bag, the parsed
 * input — so its cost is the request's, not a row's: at 50 audited writes a second an unbounded
 * array is 4.3M immortal records a day and the pod dies holding the trail it was retaining. This
 * sink was the one memory implementation in the framework with no cap, beside five that have one
 * (`memoryRateLimitStore`, `MemoryIdempotencyStore`, `createLimiter`, `createTotpReplayGuard`,
 * `createMemoryEventBus`).
 */
export const DEFAULT_MAX_AUDIT_RECORDS = 1_000;

export interface MemoryAuditSinkOptions {
  /** Records held at once. Absent, zero, negative or NaN all read as the default — never "no cap". */
  readonly maxRecords?: number | undefined;
}

/**
 * The seam's memory implementation, for tests and `x dev`. **Not a system of record, and not
 * merely because it is not durable: it DISCARDS.** Past `maxRecords` the oldest record is dropped
 * on every write, so an audited action can run, succeed, be recorded, and leave nothing behind —
 * which is exactly what an audit trail must never do. The trap this shape exists to make visible
 * is that the shortest edit clearing `X_AUDIT_SINK_MISSING` is `setAuditSink(memoryAuditSink())`,
 * and nothing about the call site says the result is amnesiac. A deployment that must keep its
 * trail installs `postgresAuditSink({ executor })`, which drops nothing.
 *
 * `dropped` is what makes that statement checkable in a running process rather than a sentence
 * here: a non-zero count on a real deployment is the sink saying it is the wrong one.
 */
export interface MemoryAuditSink extends AuditSink {
  /** The retained window, oldest first. A copy — the log cannot be mutated through it. */
  records(): readonly AuditRecord[];
  /** Retained right now — the bound, observable. */
  readonly size: number;
  /** Records this sink has DISCARDED since the last `clear()`. Never a number to ignore. */
  readonly dropped: number;
  clear(): void;
}

/**
 * The OLDEST goes, which is the same direction `createMemoryEventBus` evicts in and the opposite
 * of refusing new writes: a sink that stopped recording at the cap would answer "nothing has
 * happened since" for a process that has been serving all day, and the most recent attempts are
 * the ones anyone reading `x dev` is looking at.
 */
export function memoryAuditSink(options: MemoryAuditSinkOptions = {}): MemoryAuditSink {
  const declared = options.maxRecords;
  const maxRecords =
    typeof declared === 'number' && Number.isFinite(declared) && declared >= 1
      ? Math.floor(declared)
      : DEFAULT_MAX_AUDIT_RECORDS;
  const log: AuditRecord[] = [];
  let dropped = 0;

  return {
    write(record: AuditRecord): void {
      log.push(record);
      // `shift` in a loop, not a slice: the cap is only ever exceeded by one per write, so this
      // runs at most once — and it releases the evicted record's `Ctx` rather than copying the
      // array, which would hold both windows alive for the length of the copy.
      while (log.length > maxRecords) {
        log.shift();
        dropped += 1;
      }
    },
    records: (): readonly AuditRecord[] => [...log],
    get size(): number {
      return log.length;
    },
    get dropped(): number {
      return dropped;
    },
    clear: (): void => {
      log.length = 0;
      dropped = 0;
    },
  };
}
