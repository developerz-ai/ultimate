// One row of a seed graph, solved: every column has an ordered candidate list, and the first
// combination that keeps every declared rule (the entity's invariants, its keys and unique columns)
// wins. Only the columns a broken rule reads are varied, so the search stays a handful of tries.

export interface RowCheck {
  readonly name: string;
  /** The properties the rule reads — the only columns worth varying when it breaks. */
  readonly properties: readonly string[];
  holds(row: Readonly<Record<string, unknown>>): boolean;
}

export interface RowProblem {
  /** In declaration order; every list non-empty, first entry the most plausible. */
  readonly columns: readonly (readonly [string, readonly unknown[]])[];
  readonly checks: readonly RowCheck[];
  /** Property sets no two rows of the table may share: the key, unique columns, unique rules. */
  readonly uniques: readonly (readonly string[])[];
  /** Per entry of `uniques`, the keys earlier rows already hold. */
  readonly taken: readonly ReadonlySet<string>[];
  /**
   * Per entry of `uniques`: for a one-property set, the string values earlier rows hold in it —
   * `taken`'s answer for a string candidate without building its key. With it the solver steps
   * over a candidate no row can keep instead of building and judging that row (`searchPruned`).
   */
  readonly takenStrings?: readonly (ReadonlySet<string> | undefined)[];
  /** A factory's `derive`: columns that follow from the picked ones, applied before any rule. */
  readonly derive?: ((row: Readonly<Record<string, unknown>>) => object) | undefined;
}

export type RowSolution =
  | { readonly ok: true; readonly row: Readonly<Record<string, unknown>> }
  | {
      readonly ok: false;
      /** The rules the most plausible row breaks, by name. */
      readonly broken: readonly string[];
      readonly properties: readonly string[];
      /** Only uniqueness is out of reach: the table is full, not unsatisfiable. */
      readonly capacity: boolean;
    };

/** Past this many tries a rule is reported, not searched: the answer is a factory, not patience. */
const MAX_TRIES = 4096;
const ROUNDS = 3;

/** `undefined` when any part is null: Postgres never compares two NULLs equal in a unique key. */
export const uniqueKey = (
  row: Readonly<Record<string, unknown>>,
  properties: readonly string[],
): string | undefined => {
  // Own properties only: a column named `constructor` must not read the prototype's.
  const parts = properties.map((property) =>
    Object.hasOwn(row, property) ? row[property] : undefined,
  );
  return parts.some((part) => part === null || part === undefined)
    ? undefined
    : JSON.stringify(parts);
};

interface Broken {
  readonly names: readonly string[];
  readonly properties: ReadonlySet<string>;
}

const brokenBy = (problem: RowProblem, row: Record<string, unknown>, unique: boolean): Broken => {
  const names: string[] = [];
  const properties = new Set<string>();
  for (const check of problem.checks) {
    if (check.holds(row)) continue;
    names.push(check.name);
    for (const property of check.properties) properties.add(property);
  }
  if (unique) {
    problem.uniques.forEach((set, index) => {
      const key = uniqueKey(row, set);
      if (key === undefined || problem.taken[index]?.has(key) !== true) return;
      names.push(`unique (${set.join(', ')})`);
      for (const property of set) properties.add(property);
    });
  }
  return { names, properties };
};

const build = (problem: RowProblem, picks: readonly number[]): Record<string, unknown> => {
  const row: Record<string, unknown> = {};
  problem.columns.forEach(([property, candidates], index) => {
    row[property] = candidates[picks[index] ?? 0];
  });
  return problem.derive === undefined ? row : { ...row, ...problem.derive(row) };
};

/** Odometer over the varied columns, last one fastest: deterministic and exhaustive up to the cap. */
function* combinations(problem: RowProblem, vary: readonly number[]): Generator<number[]> {
  const picks = problem.columns.map(() => 0);
  for (let tries = 0; tries < MAX_TRIES; tries += 1) {
    yield [...picks];
    let slot = vary.length - 1;
    for (; slot >= 0; slot -= 1) {
      const column = vary[slot] as number;
      const size = problem.columns[column]?.[1].length ?? 1;
      picks[column] = ((picks[column] ?? 0) + 1) % size;
      if (picks[column] !== 0) break;
    }
    if (slot < 0) return;
  }
}

/** The columns worth varying: the ones a broken rule reads, with more than one candidate. */
const variable = (problem: RowProblem, properties: ReadonlySet<string>): number[] =>
  problem.columns.flatMap(([property, candidates], index) =>
    properties.has(property) && candidates.length > 1 ? [index] : [],
  );

/** Each property under a one-property unique set, and the strings earlier rows hold in it. */
const takenByProperty = (problem: RowProblem): ReadonlyMap<string, ReadonlySet<string>[]> => {
  const byProperty = new Map<string, ReadonlySet<string>[]>();
  problem.uniques.forEach((set, i) => {
    const values = problem.takenStrings?.[i];
    const [property] = set;
    if (set.length !== 1 || property === undefined || values === undefined) return;
    byProperty.set(property, [...(byProperty.get(property) ?? []), values]);
  });
  return byProperty;
};

/** `brokenBy`'s verdict on the one-property sets for a string value, without building its key. */
const isTaken = (sets: readonly ReadonlySet<string>[] | undefined, value: unknown): boolean =>
  typeof value === 'string' && sets !== undefined && sets.some((values) => values.has(value));

/**
 * Per column, the candidate positions a row could keep — `undefined` for every one: a taken string
 * is dropped, as `brokenBy` refuses every row built on it. Under a `derive` nothing is dropped — it
 * may rewrite the very column a candidate was refused on — and each built row meets `isTaken` first.
 */
const keptPositions = (
  problem: RowProblem,
  byProperty: ReadonlyMap<string, ReadonlySet<string>[]>,
): { readonly kept: (readonly number[] | undefined)[]; readonly dropped: boolean } => {
  let dropped = false;
  const kept = problem.columns.map(([property, candidates]) => {
    const sets = byProperty.get(property);
    if (sets === undefined || problem.derive !== undefined) return undefined;
    const free: number[] = [];
    candidates.forEach((value, position) => {
      if (!isTaken(sets, value)) free.push(position);
    });
    if (free.length === candidates.length) return undefined;
    dropped = true;
    return free;
  });
  return { kept, dropped };
};

/**
 * `search`'s first round, stepping over rows a taken string refuses, or undefined to run `search`
 * itself. The odometer visits the kept combinations in the order `combinations` visits all of them
 * and each one stepped over breaks a unique key, so the first row that holds is `search`'s own —
 * unless `search` would stop at `MAX_TRIES` before reaching it, or find none and widen: both are
 * answered by `search`. The stepping over is the point: a tenant child of a shared parent under a
 * table-wide unique key walked past every parent earlier tenants took, a judged row each —
 * quadratic in tenants (an adopter's pass seed: 98 s of 106).
 */
const searchPruned = (problem: RowProblem): RowSolution | undefined => {
  const byProperty = takenByProperty(problem);
  if (byProperty.size === 0) return undefined;
  const { kept, dropped } = keptPositions(problem, byProperty);
  // Nothing dropped and no `derive` to judge cheaply: the plain search is this search.
  if (!dropped && problem.derive === undefined) return undefined;
  const picks = problem.columns.map(() => 0);
  const first = brokenBy(problem, build(problem, picks), true);
  if (first.names.length === 0) return { ok: true, row: build(problem, picks) };
  const vary = variable(problem, first.properties);
  const radix = vary.map((column) => problem.columns[column]?.[1].length ?? 1);
  const sizes = vary.map((column, slot) => kept[column]?.length ?? radix[slot] ?? 1);
  if (vary.length === 0 || sizes.some((size) => size === 0)) return undefined;
  const refusing = [...byProperty];
  const at = vary.map(() => 0);
  for (;;) {
    // Where `combinations` yields this one: the same odometer, over every candidate.
    let ordinal = 0;
    for (let slot = 0; slot < vary.length; slot += 1) {
      const column = vary[slot] as number;
      const step = at[slot] ?? 0;
      const position = kept[column]?.[step] ?? step;
      ordinal = ordinal * (radix[slot] ?? 1) + position;
      picks[column] = position;
    }
    if (ordinal >= MAX_TRIES) return undefined;
    const row = build(problem, picks);
    // Own properties only, as `uniqueKey` reads them: a column named `constructor` is no prototype.
    const refused = refusing.some(
      ([property, sets]) => Object.hasOwn(row, property) && isTaken(sets, row[property]),
    );
    if (!refused && brokenBy(problem, row, true).names.length === 0) return { ok: true, row };
    let slot = vary.length - 1;
    for (; slot >= 0; slot -= 1) {
      at[slot] = ((at[slot] ?? 0) + 1) % (sizes[slot] ?? 1);
      if (at[slot] !== 0) break;
    }
    if (slot < 0) return undefined;
  }
};

const search = (problem: RowProblem, unique: boolean): RowSolution => {
  const zero = problem.columns.map(() => 0);
  const first = brokenBy(problem, build(problem, zero), unique);
  const failed: RowSolution = {
    ok: false,
    broken: first.names,
    properties: [...first.properties],
    capacity: false,
  };
  if (first.names.length === 0) return { ok: true, row: build(problem, zero) };
  let wanted = new Set(first.properties);
  for (let round = 0; round < ROUNDS; round += 1) {
    const vary = variable(problem, wanted);
    const grown = new Set(wanted);
    for (const picks of combinations(problem, vary)) {
      const row = build(problem, picks);
      const broken = brokenBy(problem, row, unique);
      if (broken.names.length === 0) return { ok: true, row };
      for (const property of broken.properties) grown.add(property);
    }
    if (variable(problem, grown).length === vary.length) return failed;
    wanted = grown;
  }
  return failed;
};

/** The first row that keeps every rule; failing that, whether only uniqueness stood in the way. */
export function solveRow(problem: RowProblem): RowSolution {
  const pruned = searchPruned(problem);
  if (pruned !== undefined) return pruned;
  const found = search(problem, true);
  if (found.ok) return found;
  return search(problem, false).ok ? { ...found, capacity: true } : found;
}
