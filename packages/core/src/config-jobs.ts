// Single responsibility: `jobs.concurrency`'s domain — one slot count for every queue a worker
// serves, or a table of slots per queue (issue #676). Takes the value as `unknown` and names no
// other key, so `config.ts` keeps its one-line-per-key rule list.

import { countIssue } from './config-count';
import { describeValue } from './error-render';
import { isJsonObject } from './json-object';

/**
 * `jobs.concurrency` when no layer says, and what a queue the table does NOT name gets: the
 * number an app that never wrote `concurrency` runs every queue at. ONE constant, read by
 * `@ultimat3/jobs`' `jobWorker` for its own default too — it kept a 5 until 25.0.0, so a
 * `concurrency: { banks: 4 }` left `default` at 5 beside an unset config's 8.
 */
export const JOBS_CONCURRENCY_DEFAULT = 8;

/** One slot count for every queue, or slots per queue name — `jobWorker`'s own `concurrency`. */
export type JobsConcurrency = number | Readonly<Record<string, number>>;

const KEY = 'jobs.concurrency';

/** A queue name is shown quoted: it is the typo, and a blank one is otherwise invisible. */
const quoted = (name: string): string => `"${name}"`;

/**
 * Why `value` is not a `jobs.concurrency`, one issue per wrong entry. A table must name at least
 * one queue: `{}` reads as "every queue at the default", which the number form already says — an
 * empty table is a config whose author meant to write something and did not.
 */
export function jobsConcurrencyIssues(value: unknown): readonly string[] {
  if (typeof value === 'number') {
    const count = countIssue(KEY, value, 1);
    return count === undefined ? [] : [count];
  }
  if (!isJsonObject(value)) {
    return [
      `${KEY} must be a whole number of at least 1, or a table of slots per queue like { mail: 4 }, not ${describeValue(value)}`,
    ];
  }
  const entries = Object.entries(value);
  if (entries.length === 0) {
    return [`${KEY} must name at least one queue, or be a number for every queue`];
  }
  const issues: string[] = [];
  for (const [queue, slots] of entries) {
    if (queue.trim() === '') issues.push(`${KEY} names ${quoted(queue)}, not a queue`);
    const count = countIssue(`${KEY}.${queue}`, slots, 1);
    if (count !== undefined) issues.push(count);
  }
  return issues;
}
