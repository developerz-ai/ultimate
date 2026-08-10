// The structural subset of a registered entity the admin reads, and the query IR it speaks.
//
// WHY a subset instead of importing `Entity` itself: the admin must keep deriving after an
// entity gains a column kind it has never heard of, so the surface is named — `$columns`,
// `$primaryKey`, `$describe()` — and one file changes when it grows. `RegisteredEntity` below
// is the compile-time proof that a real `entity()` result satisfies it; it is checked by
// `tsc`, not asserted in a comment, because the admin used to read fields no entity had.

import type { Entity, Repo } from '@ultimat3/entity';

/**
 * What the author declared about one column — `@ultimat3/entity`'s `ColumnMeta`, narrowed to
 * what the admin reads. `kind` stays `string`: a kind with no widget is a loud
 * X_ADMIN_FIELD_UNSUPPORTED at derive time, never a type error in the app that declared it.
 */
export interface AdminColumnMeta {
  /** `uuid` · `text` · `char` · `boolean` · `integer` · `bigint` · `timestamptz` · `jsonb` · `money`. */
  readonly kind: string;
  readonly notNull: boolean;
  readonly primaryKey: boolean;
  readonly unique: boolean;
  /** Indexed columns become the list filters — a filter with no index is a table scan. */
  readonly index: boolean;
  /** Declared max length. A bounded string is one line; an unbounded one is prose. */
  readonly length?: number;
  /** A closed set — `enumerated`, `locale`, `tz`. Forces the `select` widget. */
  readonly values?: readonly string[];
  /**
   * `kind: 'generated'` means the DB or the framework writes it (`id`, `createdAt`), which is
   * what makes a field read-only. A literal `.default('free')` is a starting value, not that.
   */
  readonly default?: { readonly kind: string };
  readonly onUpdate?: { readonly kind: string };
  /**
   * A thunk, because schema modules import each other in a cycle. The admin never calls it —
   * the column→entity binding that resolves it is private to @ultimat3/entity, so `$describe()`
   * hands back the resolved target — but its presence is what makes the column a foreign key.
   */
  readonly references?: () => unknown;
}

/** One column of a registered entity. An `@ultimat3/entity` `Column` satisfies this. */
export interface AdminColumn {
  readonly $meta: AdminColumnMeta;
}

/** One column of `$describe()` output. Money is the one property that becomes two of these. */
export interface AdminColumnDescription {
  /** The property key on the row, which is what the admin renders and filters by. */
  readonly property: string;
  /** `"<entity>.<column>"` for a foreign key, else `null`. Already resolved. */
  readonly references: string | null;
}

/** The plain-data projection of an entity. The admin reads it for FK targets only. */
export interface AdminEntityDescription {
  readonly columns: readonly AdminColumnDescription[];
}

export interface AdminEntity {
  readonly $name: string;
  /** Property keys of the primary key. Composite for a join table; the admin addresses rows
   * by the first, which is the only column a single-id URL and an `AdminRepo` can carry. */
  readonly $primaryKey: readonly string[];
  readonly $columns: Readonly<Record<string, AdminColumn>>;
  /** The Standard Schema the entity validates with; forms hand input straight to it. */
  readonly $schema: unknown;
  /** Resolves foreign-key targets. See `entity-columns.ts` for what the admin takes from it. */
  $describe(): AdminEntityDescription;
}

/** `T` must satisfy `Surface` or this does not compile. The whole point of the two below. */
type Satisfies<Surface, T extends Surface> = T;

/**
 * The claim, checked: a real `entity()` result IS an `AdminEntity`. The day `entity()` renames
 * a member, `tsc` fails here — instead of `Object.keys(entity.columns)` failing in the first
 * request the dashboard serves.
 */
export type RegisteredEntity = Satisfies<AdminEntity, Entity<AdminRow>>;

/**
 * A repo as `@ultimat3/entity` registers it — deliberately NOT claimed to be an `AdminRepo`:
 * the verbs differ (`findMany`/`insert` vs `list`/`create`) and its cursor is an opaque signed
 * string where the admin speaks a keyset bound, so the host binds an adapter over it.
 */
export type RegisteredRepo = Repo;

export type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'lt' | 'in' | 'is-null';

export interface AdminFilter {
  readonly field: string;
  readonly op: FilterOp;
  readonly value: string | number | boolean | null | readonly string[];
}

export interface AdminSort {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

export interface KeysetBound {
  readonly field: string;
  readonly value: string;
  readonly id: string;
}

/**
 * The read query the admin sends a repo. There is no `offset` and there never will be:
 * offset pagination re-scans on every page and skips rows when the table is written to
 * while an operator is paging through it.
 */
export interface AdminListQuery {
  readonly where?: readonly AdminFilter[];
  readonly sort: AdminSort;
  /** Rows to return. The repo is asked for `limit + 1` to detect a next page. */
  readonly limit: number;
  /**
   * Keyset bound: the sort-field value of the last row of the previous page, plus that
   * row's id as the tie-break so pages stay stable when the sort column has duplicates.
   */
  readonly after?: KeysetBound;
  readonly before?: KeysetBound;
}

export interface AdminRepo<Row> {
  list(query: AdminListQuery): Promise<readonly Row[]>;
  find(id: string): Promise<Row | null>;
  create(input: Readonly<Record<string, unknown>>): Promise<Row>;
  update(id: string, patch: Readonly<Record<string, unknown>>): Promise<Row>;
  destroy(id: string): Promise<void>;
  count?(where?: readonly AdminFilter[]): Promise<number>;
}

/** What the admin runs an action with. The action's own `ctx` is richer; this is the slice
 * the admin can honestly provide from an HTTP request or an MCP call. */
export interface AdminActionCtx {
  readonly requestId: string;
  readonly actorId: string;
  readonly locale: string;
  readonly timeZone: string;
}

/**
 * A registered `action` as the admin surfaces it. `permission` is not optional: an action
 * with no policy is an open door, and the admin refuses to render one
 * (X_ADMIN_POLICY_MISSING).
 */
export interface AdminAction<Input = Readonly<Record<string, unknown>>, Output = unknown> {
  readonly name: string;
  readonly permission: string;
  /** The entity the button belongs to. Absent = a global action in the toolbar. */
  readonly entity?: string;
  readonly destructive?: boolean;
  readonly labelKey?: string;
  /** Mirrors the action's own `mcp` block; the admin MCP surface honours `expose`. */
  readonly mcp?: { readonly expose?: boolean; readonly description?: string };
  /** The action's Standard Schema, handed to the form and to the MCP tool definition. */
  readonly input?: unknown;
  handle(args: { input: Input; ctx: AdminActionCtx }): Promise<Output>;
}

/** A registered `job` as the admin's Jobs page needs it — `describeJobs()` output. */
export interface AdminJobSummary {
  readonly name: string;
  readonly queue?: string;
  readonly steps?: readonly string[];
  readonly retry?: { readonly attempts: number; readonly backoff: string };
}

/** A row as the admin handles it: an opaque record it reads fields out of by name. */
export type AdminRow = Readonly<Record<string, unknown>>;

export function readField(row: AdminRow, field: string): unknown {
  return row[field];
}

export function rowId(row: AdminRow, idField: string): string {
  const value = row[idField];
  return typeof value === 'string' ? value : String(value ?? '');
}
