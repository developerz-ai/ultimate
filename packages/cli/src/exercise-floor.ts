// The `exercise` key of `x.verify.json`: how many reached primitives the pass may leave `unproven`,
// as a ratio of the reached, and the verdict on a report against it. Absent is a WARNING naming the
// figure to write (an app that never opted in stays green on `main`); present, above it is red.
// The ratchet only falls: a figure under the floor is a warning naming the lower number.

import { ERROR_DOCS_URL, renderCauseValue } from '@ultimat3/core';
import type { ExerciseRecord } from '@ultimat3/testing';
import type { Finding } from './output';

/** The floor's exercise key. Named once: the problem quotes it and the fix repairs it. */
export const EXERCISE_FIELD = 'exercise';

export interface ExerciseFloor {
  /** Unproven ÷ reached the pass may report, `0` to `1`. `x new` writes `0`; `x upgrade` the measured figure. */
  readonly unprovenMax?: number;
  /** Statements one primitive call may issue before the pass reports it (`@ultimat3/testing`'s X4). */
  readonly statementsMax?: number;
}

const KEYS = ['unprovenMax', 'statementsMax'] as const;

/** `{ "unprovenMax": 0.05, "statementsMax": 100 }`, or the problems — a typo covers nothing. */
export function readExerciseFloor(payload: Record<string, unknown> | undefined): {
  floor?: ExerciseFloor;
  problems: readonly string[];
} {
  const raw = payload?.[EXERCISE_FIELD];
  if (raw === undefined) return { problems: [] };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { problems: [`"${EXERCISE_FIELD}" is not an object of { "unprovenMax": ratio }`] };
  }
  const problems: string[] = [];
  const floor: { unprovenMax?: number; statementsMax?: number } = {};
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'unprovenMax') {
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1) {
        floor.unprovenMax = value;
      } else {
        problems.push(
          `"${EXERCISE_FIELD}.unprovenMax" is ${JSON.stringify(value)}, which is not a ratio from 0 to 1`,
        );
      }
    } else if (key === 'statementsMax') {
      if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 1) {
        floor.statementsMax = value;
      } else {
        problems.push(
          `"${EXERCISE_FIELD}.statementsMax" is ${JSON.stringify(value)}, which is not a whole number of statements`,
        );
      }
    } else {
      problems.push(`"${EXERCISE_FIELD}" names ${key}, which is not one of ${KEYS.join(', ')}`);
    }
  }
  return { ...(Object.keys(floor).length === 0 ? {} : { floor }), problems };
}

type Proven = Pick<ExerciseRecord, 'kind' | 'name' | 'outcome' | 'tenant' | 'crash' | 'scale'>;

/** The first proof that could not ask, with the reason it gave. */
const unprovenReason = (record: Proven): string | undefined => {
  for (const [proof, verdict] of [
    ['tenant', record.tenant],
    ['crash', record.crash],
    ['scale', record.scale],
  ] as const) {
    if (verdict?.verdict === 'unproven') return `${proof}: ${verdict.reason}`;
  }
  return undefined;
};

export interface UnprovenTally {
  readonly reached: number;
  readonly unproven: readonly { readonly name: string; readonly reason: string }[];
  /** Unproven ÷ reached, rounded UP to 4 places so a written figure always holds its own run. */
  readonly figure: number;
}

export function unprovenTally(records: readonly Proven[]): UnprovenTally {
  const reached = records.filter((one) => one.outcome === 'reached');
  const unproven = reached.flatMap((one) => {
    const reason = unprovenReason(one);
    return reason === undefined ? [] : [{ name: `${one.kind} ${one.name}`, reason }];
  });
  const ratio = reached.length === 0 ? 0 : unproven.length / reached.length;
  return { reached: reached.length, unproven, figure: Math.ceil(ratio * 10_000) / 10_000 };
}

/** How many unproven records a finding names: the head is where to start. */
const NAMED = 3;

/** The verdict: red above a declared floor, a warning without one, a warning when it can fall. */
export function judgeUnproven(
  records: readonly Proven[],
  floor: ExerciseFloor | undefined,
): { readonly findings: readonly Finding[]; readonly warnings: readonly string[] } {
  const tally = unprovenTally(records);
  const count = `${String(tally.unproven.length)} of ${String(tally.reached)} reached primitive(s)`;
  const max = floor?.unprovenMax;
  const hold = `"${EXERCISE_FIELD}": { "unprovenMax": ${String(tally.figure)} }`;
  if (max === undefined) {
    return tally.unproven.length === 0
      ? { findings: [], warnings: [] }
      : {
          findings: [],
          warnings: [
            `exercise left ${count} unproven (${String(tally.figure)}): hold it with ${hold} in x.verify.json, 0 to require every proof`,
          ],
        };
  }
  if (tally.figure > max) {
    const named = tally.unproven
      .slice(0, NAMED)
      .map((one) => `${one.name} (${renderCauseValue(one.reason)})`)
      .join(', ');
    return {
      findings: [
        {
          code: 'X_EXERCISE_UNPROVEN_ABOVE_FLOOR',
          cause: `exercise left ${count} unproven, ${String(tally.figure)} of the reached; x.verify.json "${EXERCISE_FIELD}.unprovenMax" allows ${String(max)}: ${named}`,
          fix: 'x exercise --json   # each unproven record in .x/exercise.json names the proof and its reason: fix the seed or the override it names; the floor only falls',
          docs: ERROR_DOCS_URL,
          at: 'x.verify.json',
        },
      ],
      warnings: [],
    };
  }
  return tally.figure < max
    ? {
        findings: [],
        warnings: [
          `exercise left ${count} unproven (${String(tally.figure)}), under "${EXERCISE_FIELD}.unprovenMax" ${String(max)}: lower it to ${hold} in x.verify.json`,
        ],
      }
    : { findings: [], warnings: [] };
}
