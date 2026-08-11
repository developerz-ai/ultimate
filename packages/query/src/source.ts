/**
 * The `SqlSource` contract every read must satisfy, plus `from()` — the reference
 * implementation used by tests, fixtures and app queries alike. No ORM backs it: a real
 * app's `sql:` returns `from()` over an `@ultimat3/entity` repo, and a source only has to
 * answer these four questions.
 */
import type { Filter, FilterOp, OrderKey, QueryShape, SeekKey } from './shape';
import { compareRows, compareValues, matchesFilters } from './shape';
import { columnOf } from './stable';

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
  /** Cursor push-down. Absent means pagination slices after execution. */
  seek?(after: SeekKey | null, limit: number): SqlSource<TRow>;
}

export type RowProvider<TRow> = readonly TRow[] | (() => Promise<readonly TRow[]>);

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
    /** Set by `seek()`. Only a paged read pays for the id tiebreak — see `pageOrder()`. */
    private readonly paged: boolean = false,
  ) {}

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
    return this.derive({ after, rowLimit: limit, paged: true });
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
    const clauses = this.filters.map((filter) => {
      if (filter.op === 'in' && Array.isArray(filter.value)) {
        const slots = filter.value.map((item) => {
          params.push(item);
          return `$${params.length}`;
        });
        return `"${filter.column}" in (${slots.join(', ')})`;
      }
      params.push(filter.value);
      return `"${filter.column}" ${filter.op} $${params.length}`;
    });
    if (this.after !== null) clauses.push(this.seekClause(this.after, params));
    const where = clauses.length > 0 ? ` where ${clauses.join(' and ')}` : '';
    const keys = this.pageOrder();
    const order =
      keys.length > 0
        ? ` order by ${keys.map((key) => `"${key.column}" ${key.direction}`).join(', ')}`
        : '';
    const limit = this.rowLimit === null ? '' : ` limit ${this.rowLimit}`;
    return { sql: `select * from "${this.entity}"${where}${order}${limit}`, params };
  }

  async execute(): Promise<readonly TRow[]> {
    const source = typeof this.rows === 'function' ? await this.rows() : this.rows;
    let result = source.filter((row) => matchesFilters(row, this.filters));
    const keys = this.pageOrder();
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
   * The ordering a page is actually served in: the declared keys, then `id` to make it total.
   *
   * Without the tiebreak the database is free to return two rows with the same sort value in
   * either order, while `seekClause()` decides the next page as if they had been ordered by id —
   * so one of the pair comes back twice and the other never does. `execute()` had the same split,
   * sorting by the declared keys and then filtering with the id-aware predicate. One order, read
   * by the SQL, the in-memory sort and the predicate alike, is what closes it.
   *
   * Only a paged read pays for it: an unpaginated `from()` over rows that have no `id` must keep
   * generating exactly the SQL it was asked for.
   */
  private pageOrder(): readonly OrderKey[] {
    if (!this.paged || this.ordersById) return this.order;
    return [...this.order, { column: 'id', direction: 'asc' }];
  }

  /**
   * The keyset predicate, spelled out per key rather than as a row comparison.
   * `(created_at, id) < ($1, $2)` requires every key to sort the same way, and a
   * listing that is `createdAt desc, id asc` does not — the id-tiebreak-only
   * fallback this replaced returned rows the ordering had already been past, so
   * a mixed listing repeated and skipped rows while `execute()` did the right
   * thing. Same shape as `@ultimat3/entity`'s `seekSql`: one meaning, two drivers.
   */
  private seekClause(after: SeekKey, params: unknown[]): string {
    const slot = (value: unknown): string => {
      params.push(value);
      return `$${params.length}`;
    };
    // The same `pageOrder()` the ORDER BY is built from, so the predicate can only ever describe
    // the order the rows actually arrive in. The tiebreak is absent when the ordering already
    // named `id`: a second `id` term compares the key to itself, can never be true, and is dead
    // SQL an agent then has to reason about.
    const keys = this.pageOrder();
    const values = this.ordersById ? [...after.key] : [...after.key, after.id];
    const terms = keys.map((key, index) => {
      const equal = keys
        .slice(0, index)
        .map((earlier, position) => `"${earlier.column}" = ${slot(values[position])}`);
      const compare = `"${key.column}" ${key.direction === 'desc' ? '<' : '>'} ${slot(values[index])}`;
      return `(${[...equal, compare].join(' and ')})`;
    });
    return `(${terms.join(' or ')})`;
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
      patch.paged ?? this.paged,
    );
  }
}

interface BuilderState {
  readonly filters: readonly Filter[];
  readonly order: readonly OrderKey[];
  readonly rowLimit: number | null;
  readonly after: SeekKey | null;
  readonly unsupported: readonly string[];
  readonly paged: boolean;
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
