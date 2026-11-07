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
  const variable = (properties: ReadonlySet<string>): number[] =>
    problem.columns.flatMap(([property, candidates], index) =>
      properties.has(property) && candidates.length > 1 ? [index] : [],
    );
  let wanted = new Set(first.properties);
  for (let round = 0; round < ROUNDS; round += 1) {
    const vary = variable(wanted);
    const grown = new Set(wanted);
    for (const picks of combinations(problem, vary)) {
      const row = build(problem, picks);
      const broken = brokenBy(problem, row, unique);
      if (broken.names.length === 0) return { ok: true, row };
      for (const property of broken.properties) grown.add(property);
    }
    if (variable(grown).length === vary.length) return failed;
    wanted = grown;
  }
  return failed;
};

/** The first row that keeps every rule; failing that, whether only uniqueness stood in the way. */
export function solveRow(problem: RowProblem): RowSolution {
  const found = search(problem, true);
  if (found.ok) return found;
  return search(problem, false).ok ? { ...found, capacity: true } : found;
}
