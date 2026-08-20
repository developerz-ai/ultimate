/**
 * The `SqlSource` contract every read must satisfy, plus `from()` — the reference
 * implementation used by tests, fixtures and app queries alike. No ORM backs it: a real
 * app's `sql:` returns `from()` over an `@ultimat3/entity` repo, and a source only has to
 * answer these four questions.
 */
import type { Filter, FilterOp, OrderKey, QueryShape, SeekKey } from './shape';
import { compareRows, compareValues, isNull, matchesFilters, totalOrder } from './shape';
import { columnOf } from './stable';

/** Nothing matches. `in ()` is a syntax error in Postgres, so an empty set needs a constant. */
const NEVER = '1 = 0';

/** Binds a value and answers the `$n` that reads it. Nothing here interpolates a value. */
type Slot = (value: unknown) => string;

export interface SqlText {
  readonly sql: string;
  readonly params: readonly unknown[];
}

export interface SqlSource<TRow> {
  /** The generated SQL, verbatim. Agents read this to self-correct. */
  toSQL(): SqlText;
  execute(): Promise<readonly TRow[]>;
  /** Required for `live: true`: the matcher patches from the shape, not from SQL. */
  shape(): QueryShape;
  /**
   * The same read served in `totalOrder` — the declared keys, then `id`. A live read is built
   * through this, because the matcher places a patched row by that order and a reconnect resumes
   * by it. Absent means the source already serves one order it can be resumed in.
   */
  total?(): SqlSource<TRow>;
  /** Cursor push-down. Absent means pagination slices after execution. */
  seek?(after: SeekKey | null, limit: number): SqlSource<TRow>;
}

/**
 * Rows, or a function that answers them. The function half is `readonly TRow[] | Promise<…>`
 * because `execute()` **awaits** whatever it returns — declaring only the promise refused a
 * synchronous provider the implementation has always accepted, which is a repo method that
 * already has its page in hand, and every in-memory fixture.
 */
export type RowProvider<TRow> =
  | readonly TRow[]
  | (() => readonly TRow[] | Promise<readonly TRow[]>);

/**
 * In-memory reference source. `from<Post>('posts', rows).where({ orgId }).orderBy('createdAt')`
 * generates real SQL text for `explain()` while executing against the provided rows.
 */
export function from<TRow extends object>(entity: string, rows: RowProvider<TRow>): Builder<TRow> {
  return new Builder<TRow>(entity, rows, [], [], null, null, []);
}

export class Builder<TRow extends object> implements SqlSource<TRow> {
  constructor(
    private readonly entity: string,
    private readonly rows: RowProvider<TRow>,
    private readonly filters: readonly Filter[],
    private readonly order: readonly OrderKey[],
    private readonly rowLimit: number | null,
    private readonly after: SeekKey | null,
    private readonly unsupported: readonly string[],
    /** Set by `seek()` and `total()` — the only reads that pay for the id tiebreak. */
    private readonly totalized: boolean = false,
  ) {}

  /**
   * One equality filter per key, and the clauses come out in **lexical key order** — not the order
   * the object literal was typed in. The generated text is something callers compare across runs:
   * `explain()` prints it, `LiveQuery.sqlText` caches it, and tests pin it. Reordering two keys in
   * a call site must not rewrite the statement.
   */
  where(equals: Readonly<Record<string, unknown>>): Builder<TRow> {
    const added = Object.keys(equals)
      .sort()
      .map((column): Filter => ({ column, op: '=', value: equals[column] }));
    return this.derive({ filters: [...this.filters, ...added] });
  }

  compare(column: string, op: FilterOp, value: unknown): Builder<TRow> {
    return this.derive({ filters: [...this.filters, { column, op, value }] });
  }

  orderBy(column: string, direction: 'asc' | 'desc' = 'asc'): Builder<TRow> {
    return this.derive({ order: [...this.order, { column, direction }] });
  }

  limit(rowLimit: number): Builder<TRow> {
    return this.derive({ rowLimit });
  }

  /** Declares a feature the matcher cannot patch — `live` then fails loudly. */
  raw(feature: string): Builder<TRow> {
    return this.derive({ unsupported: [...this.unsupported, feature] });
  }

  seek(after: SeekKey | null, limit: number): Builder<TRow> {
    return this.derive({ after, rowLimit: limit, totalized: true });
  }

  /**
   * The declared keys plus the `id` tiebreak, with no cursor and no window — page one of the
   * ordering a paged read already serves. `seek()` implies it; a live read asks for it directly.
   */
  total(): Builder<TRow> {
    return this.derive({ totalized: true });
  }

  shape(): QueryShape {
    return {
      entity: this.entity,
      filters: this.filters,
      orderBy: this.order,
      limit: this.rowLimit,
      unsupported: this.unsupported,
    };
  }

  toSQL(): SqlText {
    const params: unknown[] = [];
    const slot = slotter(params);
    const clauses = this.filters.map((filter) => filterClause(filter, slot));
    if (this.after !== null) clauses.push(this.seekClause(this.after, slot));
    const where = clauses.length > 0 ? ` where ${clauses.join(' and ')}` : '';
    const keys = this.servedOrder();
    const order = keys.length > 0 ? ` order by ${keys.map(orderTerm).join(', ')}` : '';
    const limit = this.rowLimit === null ? '' : ` limit ${this.rowLimit}`;
    return { sql: `select * from "${this.entity}"${where}${order}${limit}`, params };
  }

  async execute(): Promise<readonly TRow[]> {
    const source = typeof this.rows === 'function' ? await this.rows() : this.rows;
    let result = source.filter((row) => matchesFilters(row, this.filters));
    const keys = this.servedOrder();
    if (keys.length > 0) {
      result = [...result].sort((a, b) => compareRows(a, b, keys));
    }
    if (this.after !== null) {
      const cut = this.after;
      result = result.filter((row) => isAfterKey(row, cut, this.order));
    }
    return this.rowLimit === null ? result : result.slice(0, this.rowLimit);
  }

  /** True when the ordering already names `id`, so the tiebreak is neither added nor doubled. */
  private get ordersById(): boolean {
    return this.order.some((key) => key.column === 'id');
  }

  /**
   * The ordering this read is actually served in — `totalOrder`, so the SQL, the in-memory sort,
   * `seekClause()` and the matcher all read one list.
   *
   * Only a read that asked for it pays: `seek()` for a page, `total()` for a live window. A plain
   * `from()` over rows that have no `id` must keep generating exactly the SQL it was asked for.
   */
  private servedOrder(): readonly OrderKey[] {
    return this.totalized ? totalOrder(this.order) : this.order;
  }

  /**
   * The keyset predicate, spelled out per key rather than as a row comparison.
   * `(created_at, id) < ($1, $2)` requires every key to sort the same way, and a
   * listing that is `createdAt desc, id asc` does not — the id-tiebreak-only
   * fallback this replaced returned rows the ordering had already been past, so
   * a mixed listing repeated and skipped rows while `execute()` did the right
   * thing. Same shape as `@ultimat3/entity`'s `seekSql`: one meaning, two drivers.
   */
  private seekClause(after: SeekKey, slot: Slot): string {
    // The same `servedOrder()` the ORDER BY is built from, so the predicate can only ever describe
    // the order the rows actually arrive in. The tiebreak is absent when the ordering already
    // named `id`: a second `id` term compares the key to itself, can never be true, and is dead
    // SQL an agent then has to reason about.
    const keys = this.servedOrder();
    const values = this.ordersById ? [...after.key] : [...after.key, after.id];
    const terms: string[] = [];
    for (const [index, key] of keys.entries()) {
      const value = values[index];
      // Under `nulls last` nothing sorts after a NULL, so this key's term is dead SQL — dropped
      // rather than emitted, exactly as the doubled id tiebreak is. The remaining keys still
      // carry the page: the equality prefix below reaches them as `"col" is null`.
      if (isNull(value) && key.direction === 'asc') continue;
      const equal = keys
        .slice(0, index)
        .map((earlier, position) => equalTerm(earlier.column, values[position], slot));
      terms.push(`(${[...equal, afterTerm(key, value, slot)].join(' and ')})`);
    }
    // Every key null under an ascending order is the very end of the listing. Only reachable
    // from a hand-built cursor — `seekKeyOf` refuses a row with no id — but `()` is a syntax error.
    return terms.length === 0 ? NEVER : `(${terms.join(' or ')})`;
  }

  private derive(patch: Partial<BuilderState>): Builder<TRow> {
    return new Builder<TRow>(
      this.entity,
      this.rows,
      patch.filters ?? this.filters,
      patch.order ?? this.order,
      patch.rowLimit === undefined ? this.rowLimit : patch.rowLimit,
      patch.after === undefined ? this.after : patch.after,
      patch.unsupported ?? this.unsupported,
      patch.totalized ?? this.totalized,
    );
  }
}

const slotter =
  (params: unknown[]): Slot =>
  (value) => {
    params.push(value);
    return `$${params.length}`;
  };

/**
 * One filter, in SQL that means what `matchesFilter` means.
 *
 * `= $n` with a NULL parameter is unknown in Postgres and unknown is never true, so
 * `where({ deletedAt: null })` matched every live row in memory and no row at all in the
 * database. `is null` / `is distinct from` is the pair `@ultimat3/entity`'s `predicateSql`
 * already emits — one meaning, two sources. An ordering operator needs no case: `"col" > $n`
 * against a NULL matches nothing, which is what `ordered()` now answers too.
 */
function filterClause(filter: Filter, slot: Slot): string {
  const column = `"${filter.column}"`;
  if (filter.op === 'in') {
    // `in` reads a list or nothing. A non-array operand matches no row in memory, so the SQL says
    // the same constant — the fallback below would emit `"col" in $n`, which is a syntax error a
    // driver reports instead of the empty result the two sources agree on.
    if (!Array.isArray(filter.value)) return NEVER;
    const present = filter.value.filter((item) => !isNull(item));
    const list =
      present.length === 0
        ? null
        : `${column} in (${present.map((item) => slot(item)).join(', ')})`;
    const nulls = present.length === filter.value.length ? null : `${column} is null`;
    if (list === null) return nulls ?? NEVER;
    return nulls === null ? list : `(${list} or ${nulls})`;
  }
  if (filter.op === '=') return equalTerm(filter.column, filter.value, slot);
  if (filter.op === '!=') {
    return isNull(filter.value)
      ? `${column} is not null`
      : `${column} is distinct from ${slot(filter.value)}`;
  }
  return `${column} ${filter.op} ${slot(filter.value)}`;
}

/**
 * NULL's place in the ordering, written down rather than inherited. Postgres already defaults
 * to `nulls last` under `asc` and `nulls first` under `desc` — that is the rule `compareValues`
 * implements, so the in-memory sort, the live matcher and `seekClause` below can only agree
 * with it. Saying it out loud is what keeps a driver whose default differs from re-opening the
 * divergence, and it is what an agent reads when a nullable sort key surprises it.
 */
function orderTerm(key: OrderKey): string {
  const nulls = key.direction === 'desc' ? 'nulls first' : 'nulls last';
  return `"${key.column}" ${key.direction} ${nulls}`;
}

/** `= $n` never matches a NULL — the same defect as a filter, one page later. */
function equalTerm(column: string, value: unknown, slot: Slot): string {
  return isNull(value) ? `"${column}" is null` : `"${column}" = ${slot(value)}`;
}

/**
 * Strictly past this key's value, under the ordering `orderTerm` writes.
 *
 * `desc` is `nulls first`: every non-null row follows a NULL cursor, and no NULL row follows a
 * value — which `"col" < $n` already excludes. `asc` is `nulls last`: the NULLs follow every
 * value, so a value cursor has to reach them explicitly or page two ends at the first NULL.
 */
function afterTerm(key: OrderKey, value: unknown, slot: Slot): string {
  const column = `"${key.column}"`;
  if (key.direction === 'desc') {
    return isNull(value) ? `${column} is not null` : `${column} < ${slot(value)}`;
  }
  const after = `${column} > ${slot(value)}`;
  // `id` is the tiebreak that makes the order total and `seekKeyOf` refuses a row without one,
  // so `"id" is null` is unsatisfiable: reaching for it would be dead SQL on every paged read,
  // and an `or` the planner has to defeat before it can seek the index.
  return key.column === 'id' ? after : `(${after} or ${column} is null)`;
}

interface BuilderState {
  readonly filters: readonly Filter[];
  readonly order: readonly OrderKey[];
  readonly rowLimit: number | null;
  readonly after: SeekKey | null;
  readonly unsupported: readonly string[];
  readonly totalized: boolean;
}

/**
 * Keyset comparison: strictly after the cursor's sort key, id breaking ties. Exported because
 * pagination needs the same answer when a source cannot push the seek down — a second definition
 * of "after" is how one path skips a row the other returns.
 */
export function isAfterKey(row: object, cursor: SeekKey, order: readonly OrderKey[]): boolean {
  for (const [index, key] of order.entries()) {
    const result = compareValues(columnOf(row, key.column), cursor.key[index]);
    const signed = key.direction === 'asc' ? result : -result;
    if (signed !== 0) return signed > 0;
  }
  return compareValues(columnOf(row, 'id'), cursor.id) > 0;
}
