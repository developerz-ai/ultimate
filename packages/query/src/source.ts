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
    return this.derive({ after, rowLimit: limit });
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
    const order =
      this.order.length > 0
        ? ` order by ${this.order.map((key) => `"${key.column}" ${key.direction}`).join(', ')}`
        : '';
    const limit = this.rowLimit === null ? '' : ` limit ${this.rowLimit}`;
    return { sql: `select * from "${this.entity}"${where}${order}${limit}`, params };
  }

  async execute(): Promise<readonly TRow[]> {
    const source = typeof this.rows === 'function' ? await this.rows() : this.rows;
    let result = source.filter((row) => matchesFilters(row, this.filters));
    if (this.order.length > 0) {
      result = [...result].sort((a, b) => compareRows(a, b, this.order));
    }
    if (this.after !== null) {
      const cut = this.after;
      result = result.filter((row) => afterKey(row, cut, this.order));
    }
    return this.rowLimit === null ? result : result.slice(0, this.rowLimit);
  }

  /**
   * Row-value keyset comparison — `(createdAt, id) > ($1, $2)` — which Postgres
   * can serve straight off the matching index. Mixed asc/desc orderings have no
   * single row-value form, so those fall back to the id tiebreak alone.
   */
  private seekClause(after: SeekKey, params: unknown[]): string {
    const columns = this.order.map((key) => `"${key.column}"`);
    const ascending = this.order.every((key) => key.direction === 'asc');
    const descending = this.order.every((key) => key.direction === 'desc');
    if (columns.length === 0 || (!ascending && !descending)) {
      params.push(after.id);
      return `"id" > $${params.length}`;
    }
    const slots = [...after.key, after.id].map((value) => {
      params.push(value);
      return `$${params.length}`;
    });
    return `(${[...columns, '"id"'].join(', ')}) ${ascending ? '>' : '<'} (${slots.join(', ')})`;
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
    );
  }
}

interface BuilderState {
  readonly filters: readonly Filter[];
  readonly order: readonly OrderKey[];
  readonly rowLimit: number | null;
  readonly after: SeekKey | null;
  readonly unsupported: readonly string[];
}

/** Keyset comparison: strictly after the cursor's sort key, id breaking ties. */
function afterKey(row: object, cursor: SeekKey, order: readonly OrderKey[]): boolean {
  for (const [index, key] of order.entries()) {
    const result = compareValues(columnOf(row, key.column), cursor.key[index]);
    const signed = key.direction === 'asc' ? result : -result;
    if (signed !== 0) return signed > 0;
  }
  return compareValues(columnOf(row, 'id'), cursor.id) > 0;
}
