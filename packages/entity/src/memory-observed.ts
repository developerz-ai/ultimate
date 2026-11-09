// Single responsibility: the memory driver's half of the `db.statement` event. Generated
// tests run on this driver, so a loop it never reported was a `statements` assertion that could not
// fail. One event per repository operation, attributed exactly as `postgresRepo` attributes its
// statement; nothing is sent, so `text` names the operation and holds no SQL.

import { callerStack, instrument, subscribed, tryUseContext } from '@ultimat3/core';
import { expectedQueryLoopReason } from '@ultimat3/db';
import type { MemoryRepo } from './repo';

/** What one operation reports: the verb `statementKind` reads, and its row count. */
interface Reported {
  readonly verb: 'select' | 'insert' | 'update' | 'delete';
  readonly rows: (answer: unknown) => number;
}

const none = (): number => 0;
const one = (answer: unknown): number => (answer === null || answer === undefined ? 0 : 1);
const counted = (answer: unknown): number => (typeof answer === 'number' ? answer : 0);
const listed = (answer: unknown): number => (Array.isArray(answer) ? answer.length : 0);
const paged = (answer: unknown): number =>
  typeof answer === 'object' && answer !== null && 'rows' in answer ? listed(answer.rows) : 0;

/** Every operation that would be a statement. `reset` is a test seam and reaches no database. */
const OPERATIONS = {
  findById: { verb: 'select', rows: one },
  findMany: { verb: 'select', rows: paged },
  count: { verb: 'select', rows: one },
  countBy: { verb: 'select', rows: none },
  aggregate: { verb: 'select', rows: one },
  series: { verb: 'select', rows: listed },
  approximateCount: { verb: 'select', rows: one },
  insert: { verb: 'insert', rows: one },
  insertAll: { verb: 'insert', rows: listed },
  upsertAll: { verb: 'insert', rows: listed },
  update: { verb: 'update', rows: one },
  updateWhere: { verb: 'update', rows: counted },
  delete: { verb: 'delete', rows: () => 1 },
  deleteWhere: { verb: 'delete', rows: counted },
} as const satisfies Record<string, Reported>;

type Operation = keyof typeof OPERATIONS;

/** Taken before the body runs, as Postgres answers the lock before the body it guards. */
const LOCKS = ['lock', 'lockKey'] as const;

const report = (
  entity: string,
  op: string,
  verb: Reported['verb'],
  rows: number,
  callerStack: string | undefined,
  error?: unknown,
): void => {
  if (!subscribed('db.statement')) return;
  // Emitted here, not through `@ultimat3/db`: nothing is sent, so no funnel sees it — this IS the
  // memory driver's funnel, and a subscriber must not be able to tell the two drivers apart.
  instrument('db.statement', {
    text: `${verb} ${entity}.${op} (memory driver, no SQL sent)`,
    values: [],
    // Nothing crossed a wire, and a duration made up of `Map` reads would only rank as noise.
    durationMs: 0,
    rows,
    ...(error === undefined ? {} : { error }),
    attribution: { entity, op },
    expected: expectedQueryLoopReason(),
    callerStack,
  });
};

/**
 * `postgresRepo`'s `findById` joins every lookup of one request's microtask into one `in` statement
 * (`coalesce.ts`) and declines with no request in scope. Mirrored, or `Promise.all(ids.map(byId))`
 * fails a test here that Postgres passes with one statement. The rows are still read one by one:
 * this decides only what the seam is told.
 */
const pointLookups = (): (() => boolean) => {
  let open: object | undefined;
  return () => {
    const ctx: object | undefined = tryUseContext();
    if (ctx === undefined) return true;
    if (open === ctx) return false;
    open = ctx;
    queueMicrotask(() => {
      if (open === ctx) open = undefined;
    });
    return true;
  };
};

type AnyMethod = (...args: readonly unknown[]) => Promise<unknown>;

/** `repo`, each statement-shaped method emitting once it settles, as the funnels emit. */
export function observedMemoryRepo<Row>(entity: string, repo: MemoryRepo<Row>): MemoryRepo<Row> {
  const wrapped: Record<string, AnyMethod> = {};
  const firstInMicrotask = pointLookups();
  for (const op of Object.keys(OPERATIONS) as Operation[]) {
    const method = repo[op] as AnyMethod;
    const { verb, rows } = OPERATIONS[op];
    wrapped[op] = async (...args) => {
      if (!subscribed('db.statement')) return method(...args);
      // Decided as the call is made: by the time the row is back the microtask has moved on.
      const reports = op !== 'findById' || firstInMicrotask();
      // `postgresRepo` attributes an aggregate to its function, never to `aggregate`.
      const name = op === 'aggregate' ? String(args[0]) : op;
      // Before the `await`, as the Postgres funnel reads it: nothing unless capture is on.
      const stack = callerStack();
      let answer: unknown;
      try {
        answer = await method(...args);
      } catch (error) {
        if (reports) report(entity, name, verb, 0, stack, error);
        throw error;
      }
      if (reports) report(entity, name, verb, rows(answer), stack);
      return answer;
    };
  }
  for (const op of LOCKS) {
    const method = repo[op] as AnyMethod;
    wrapped[op] = async (...args) => {
      report(entity, op, 'select', 1, callerStack());
      return method(...args);
    };
  }
  return Object.assign({}, repo, wrapped);
}
