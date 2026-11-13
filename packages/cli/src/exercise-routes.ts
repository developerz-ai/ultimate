// What `x exercise` says about the route `load`s the pass ran (`@ultimat3/testing`'s
// `exercise-route-loads.ts`), and about a primitive reached with nothing to prove: WARNING lines,
// each naming the route file or the primitive. Warnings on `main` — a page read was never judged
// before, and an app that has not opted in stays green (X_BREAKING_ON_MAIN); red needs a floor key.

import type { ExerciseRecord, RouteLoadRecord } from '@ultimat3/testing';

const where = (record: RouteLoadRecord): string => `route ${record.name} (${record.file})`;

/** Each route's load as warning lines: a loop, a call over the ceiling, a seq scan, or unrun. */
export function routeLoadWarnings(records: readonly RouteLoadRecord[]): readonly string[] {
  return records.flatMap((record): readonly string[] => {
    if (record.outcome !== 'reached') {
      return [`${where(record)} · load not exercised: ${record.reason ?? record.outcome}`];
    }
    const lines: string[] = [];
    if (record.scale?.verdict === 'grows') {
      for (const shape of record.scale.shapes) {
        lines.push(
          `${where(record)} · X_QUERY_SCALES_WITH_ROWS ${shape.fingerprint} ${String(shape.small)}→${String(shape.large)} at 2→8 rows a table: its load reads once per row — fold it into one read, or wrap it in expectedQueryLoop('<why>', fn)`,
        );
      }
    }
    const ceiling = record.statementCeiling;
    if (ceiling?.verdict === 'over') {
      const top = ceiling.top.map((shape) => `${shape.fingerprint} ×${String(shape.count)}`);
      lines.push(
        `${where(record)} · X_STATEMENTS_OVER_BUDGET ${String(ceiling.statements)} statements in one load, max ${String(ceiling.max)}: ${top.join(', ')}`,
      );
    }
    for (const finding of record.plans?.findings ?? []) {
      lines.push(`${where(record)} · ${finding.code} ${finding.table}`);
    }
    return lines;
  });
}

/** How many names an empty-reach line lists before it says how many more. */
const NAMED = 5;

/** The line's code (`@ultimat3/testing` registers it): a warning on `main`, never a finding. */
const EMPTY_REACH = 'X_EXERCISE_EMPTY_REACH';

/**
 * Reached with no statement and no effect: every proof on it is vacuous — a scale sweep of nothing
 * is "flat", a tenant proof over nothing is "proven". Said once, with the first few named.
 */
export function emptyReachWarnings(records: readonly ExerciseRecord[]): readonly string[] {
  const empty = records.filter(
    (record) =>
      record.outcome === 'reached' && record.statements === 0 && record.effects.length === 0,
  );
  if (empty.length === 0) return [];
  const named = empty.slice(0, NAMED).map((record) => `${record.kind} ${record.name}`);
  const more = empty.length > NAMED ? `, and ${String(empty.length - NAMED)} more` : '';
  return [
    `${EMPTY_REACH} ${String(empty.length)} reached primitive(s) sent no statement and had no effect, so their proofs prove nothing: ${named.join(', ')}${more} — fix: edit exercise.ts: give each an input that reaches its work, or { off: '<why>' }`,
  ];
}
