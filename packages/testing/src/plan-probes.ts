// Which whole reads in one plan a keyed scan could have probed instead: the join columns that tie
// a scan to a side bound by its own key. On empty tables the planner may walk a small-looking
// index beside a join rather than probe it per row; the probe exists when such a column leads an
// index, which `plan-sweep-fix.ts` reads off the declaration. Pure.

import { splitTop, unwrap } from './plan-conditions';

/** One scan of the plan, with every condition it was handed and its own `Index Cond`. */
export interface ProbeScan {
  readonly table: string;
  readonly alias: string | undefined;
  readonly indexCond: string | undefined;
  readonly conditions: readonly string[];
}

const SIDE = String.raw`(?:"?([A-Za-z_][\w$]*)"?\.)?"?([A-Za-z_][\w$]*)"?`;
/** `a.x = b.y`: one column against another, the only shape a probe answers. */
const COLUMN_EQUALITY = new RegExp(`^${SIDE}\\s*=\\s*${SIDE}$`);
const QUALIFIER = /"?([A-Za-z_][\w$]*)"?\.(?="?[A-Za-z_])/g;

const nameOf = (scan: ProbeScan): string => scan.alias ?? scan.table;

const conjuncts = (conditions: readonly string[]): string[] =>
  conditions.flatMap((condition) => splitTop(unwrap(condition), 'AND'));

/**
 * Bound by its own key: an `Index Cond` conjunct that names no other scan. A parameterized inner
 * scan's condition is the join itself, so it keys nothing on its own.
 */
function selfKeyed(scan: ProbeScan, others: ReadonlySet<string>): boolean {
  if (scan.indexCond === undefined) return false;
  return conjuncts([scan.indexCond]).some((conjunct) =>
    [...conjunct.replace(/'[^']*'/g, '').matchAll(QUALIFIER)].every(
      ([, qualifier]) => qualifier === undefined || !others.has(qualifier),
    ),
  );
}

interface Tie {
  readonly scan: string;
  readonly column: string;
  readonly other: string;
}

/**
 * Every `a.x = b.y` between two scans, both ways round, wherever the plan states it: a join's
 * filter, or a parameterized scan's own `Index Cond`, where its columns go unqualified.
 */
function tiesOf(scans: readonly ProbeScan[], names: ReadonlySet<string>): readonly Tie[] {
  const ties: Tie[] = [];
  for (const scan of scans) {
    for (const conjunct of conjuncts([...scan.conditions, scan.indexCond ?? ''])) {
      const match = COLUMN_EQUALITY.exec(conjunct);
      if (match === null) continue;
      const [, leftOf = nameOf(scan), left, rightOf = nameOf(scan), right] = match;
      if (left === undefined || right === undefined || leftOf === rightOf) continue;
      if (!names.has(leftOf) || !names.has(rightOf)) continue;
      ties.push({ scan: leftOf, column: left, other: rightOf });
      ties.push({ scan: rightOf, column: right, other: leftOf });
    }
  }
  return ties;
}

/**
 * Each scan's probe columns, in plan order: the columns it is tied to a keyed scan by. A scan
 * that has any is keyed in turn, so the probe carries along a chain of joins; two scans tied only
 * to each other probe nothing — one of them is read whole either way.
 */
export function probesOf(scans: readonly ProbeScan[]): readonly (readonly string[])[] {
  const names = new Set(scans.map(nameOf));
  const keyed = new Set(
    scans
      .filter((scan) => selfKeyed(scan, new Set([...names].filter((n) => n !== nameOf(scan)))))
      .map(nameOf),
  );
  const ties = tiesOf(scans, names);
  const probes = scans.map((): string[] => []);
  for (let grew = true; grew; ) {
    grew = false;
    scans.forEach((scan, at) => {
      const own = nameOf(scan);
      if (keyed.has(own)) return;
      const found = ties.flatMap((tie) =>
        tie.scan === own && keyed.has(tie.other) ? [tie.column] : [],
      );
      if (found.length === 0) return;
      probes[at] = [...new Set(found)];
      keyed.add(own);
      grew = true;
    });
  }
  return probes;
}
