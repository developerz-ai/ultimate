// The structural subset of the registries the admin reads, and the query IR it speaks.
//
// WHY these are declared here instead of imported as concrete types: the admin derives
// itself from `describeEntities()` output, and it must keep deriving after an entity gains
// a column kind the admin has never heard of. Declaring the read surface — name, columns,
// keys — means one file changes when the registry grows, and `Entity` / `Repo` from
// @ultimat3/entity satisfy it structurally with no adapter.

import type { Entity, Repo } from '@ultimat3/entity';

/** One column as the admin needs to see it. A Drizzle column descriptor satisfies this. */
export interface AdminColumn {
  /** The SQL-ish type name: `text`, `varchar`, `timestamptz`, `numeric`, `jsonb`, … */
  readonly type: string;
  readonly nullable?: boolean;
  readonly unique?: boolean;
  readonly primaryKey?: boolean;
  /** Indexed columns become the list filters — a filter with no index is a table scan. */
  readonly index?: boolean;
  /** Written by the DB or the framework (`id`, `createdAt`): read-only in every form. */
  readonly generated?: boolean;
  /** Present on enum columns; also forces the `select` widget on a text column. */
  readonly values?: readonly string[];
  /** Present on money columns. ISO-4217. */
  readonly currency?: string;
  /** Present on FK columns; drives the searchable-reference widget. */
  readonly references?: { readonly entity: string; readonly column?: string };
  /** Redacted in the audit diff and never rendered. */
  readonly sensitive?: boolean;
  readonly multiline?: boolean;
}

export interface AdminEntity {
  readonly name: string;
  readonly table?: string;
  readonly columns: Readonly<Record<string, AdminColumn>>;
  /** The Standard Schema the entity validates with; forms hand input straight to it. */
  readonly schema?: unknown;
  /** The column to show when this entity is referenced from elsewhere. */
  readonly labelColumn?: string;
}

/** Compile-time note: a registered `Entity` is meant to be usable as an `AdminEntity`. */
export type RegisteredEntity = Entity<AdminRow>;
/** Compile-time note: a registered `Repo` is meant to be usable as an `AdminRepo`. */
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
