// The structural subset of a registered entity the admin reads, and the query IR it speaks.
//
// WHY a subset instead of importing `Entity` itself: the admin must keep deriving after an
// entity gains a column kind it has never heard of, so the surface is named — `$columns`,
// `$primaryKey`, `$describe()` — and one file changes when it grows. `RegisteredEntity` below
// is the compile-time proof that a real `entity()` result satisfies it; it is checked by
// `tsc`, not asserted in a comment, because the admin used to read fields no entity had.

import type { Entity, Operator, Table } from '@ultimat3/entity';

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
  /**
   * `.sealed()`: encrypted at rest, opened on read, absent from every schema that leaves the
   * server. Present means the admin derives NO readable field for it — see `entity-columns.ts`.
   */
  readonly sealed?: { readonly lookup: boolean };
}

/** One column of a registered entity. An `@ultimat3/entity` `Column` satisfies this. */
export interface AdminColumn {
  readonly $meta: AdminColumnMeta;
  /**
   * The column's own guard. Optional in this surface only because a hand-built fixture has none;
   * every `entity()` column carries it, and `repo-entity.ts` parses a URL's id through it.
   */
  readonly $parse?: (value: unknown) => unknown;
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
  /**
   * The column the handle scopes every read and write by, or `null`. Optional in this surface only
   * because a hand-built fixture has none; every `entity()` result carries it. The admin never
   * renders it as an input — the acting actor's tenant is the only value it may hold.
   */
  readonly $tenantColumn?: string | null;
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
 * The slice of a typed handle's read chain the admin drives — `database()`'s `db.<entity>`. Named
 * for the reason `AdminEntity` is: one file changes when the handle grows, and `RegisteredTable`
 * is the `tsc`-checked proof a real one satisfies it.
 */
export interface AdminTableRead {
  where(filter: Readonly<Record<string, unknown>>): AdminTableRead;
  andWhere(column: string, op: Operator, value?: unknown): AdminTableRead;
  orderBy(column: string, direction?: 'asc' | 'desc'): AdminTableRead;
  limit(rows: number): AdminTableRead;
  all(): Promise<readonly AdminRow[]>;
  one(): Promise<AdminRow | null>;
  count(): Promise<number>;
  /** Read for the entity NAME only: it is how a handle is matched to the entity it serves. */
  plan(): { readonly entity: string };
}

/** One table of the app's typed handle. Tenancy, soft delete and sealing are its own. */
export interface AdminTable extends AdminTableRead {
  insert(values: Readonly<Record<string, unknown>>): Promise<AdminRow>;
  update(id: string, patch: Readonly<Record<string, unknown>>): Promise<AdminRow>;
  delete(id: string): Promise<void>;
}

/** The app's `database()` result, as `defineAdmin({ db })` takes it. Keys are the app's spelling. */
export type AdminDb = Readonly<Record<string, AdminTable>>;

/** The claim, checked: `database()`'s table IS an `AdminTable`. */
export type RegisteredTable = Satisfies<AdminTable, Table<AdminRow>>;

export type FilterOp =
  | 'eq'
  | 'neq'
  | 'contains'
  | 'gt'
  | 'gte'
  | 'lt'
  | 'lte'
  | 'in'
  /** `value: true` keeps the rows with no value, `value: false` the rows with one. */
  | 'is-null';

export const FILTER_OPS: readonly FilterOp[] = [
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'is-null',
];

/**
 * One predicate of a list read. Every list the admin issues is a CONJUNCTION of these — the URL's
 * filters, the scope's, and the resource's row scope — so each maps to one indexed comparison.
 */
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
  /** The boundary row's sort value as text; `null` when it holds none, which sorts LAST. */
  readonly value: string | null;
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
  /**
   * The mirror of `after`. Rows come back in `sort`'s own order either way — the admin renders
   * what the repo returns and never re-sorts — so on a `before` query the `limit + 1`st row is the
   * one FURTHEST back, at index 0, and `pageFrom` trims the head rather than the tail. A repo that
   * answered nearest-first would hand the operator a reversed page.
   */
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

/** How a batch action behaves past the size a request should run inline. */
export interface AdminBatchOptions {
  /**
   * The most rows one request runs INLINE. A selection larger than this is handed to the queue —
   * one `admin.batch` job per chunk — and the answer says how many rows were queued, not done.
   */
  readonly threshold: number;
  /** Rows per queued job. Omitted: `threshold`. */
  readonly chunk?: number;
}

/** What a set-based "all matching" answers — the shape of a store's own bulk verb. */
export interface AdminMatchingResult {
  /** Rows this call changed. */
  readonly affected: number;
  /** Rows still matching afterwards. Run again until it is zero. */
  readonly remaining: number;
}

/**
 * A registered `action` as the admin surfaces it. `permission` is not optional: an action
 * with no policy is an open door, and the admin refuses to render one
 * (X_ADMIN_POLICY_MISSING).
 *
 * One declaration, every projection: the button on the detail page and on each list row, the
 * action's own form, the batch bar, the MCP tool, the audit entry. `when` and `batch` narrow WHERE
 * it appears and never add a second handler.
 */
export interface AdminAction<Input = Readonly<Record<string, unknown>>, Output = unknown> {
  readonly name: string;
  readonly permission: string;
  /** The entity the button belongs to. Absent = a global action in the toolbar. */
  readonly entity?: string;
  readonly destructive?: boolean;
  /**
   * The action changes nothing — an export, a verification, a recount — so its admin-level gate is
   * `admin:read` rather than `admin:write`, and a read-only staff role (or an `admin:read` MCP
   * token) may run it. `destructive` and `matching` (a set-based write) win over it: the stricter
   * gate is the one that applies.
   */
  readonly readonly?: boolean;
  /** Absent: `admin.action.<name>` — `actionLabelKey`, the one spelling every screen reads. */
  readonly labelKey?: string;
  /** Mirrors the action's own `mcp` block; the admin MCP surface honours `expose`. */
  readonly mcp?: { readonly expose?: boolean; readonly description?: string };
  /**
   * The action's input schema — a `t.object({ … })`. Rendered as the action's form (one control
   * per property), validated before the handler runs with each issue shown against its field,
   * and handed to the MCP tool definition. Absent: the action takes no input, and its button is a
   * confirm only. The row's `id` is the admin's own envelope and is never a property here.
   */
  readonly input?: unknown;
  /**
   * Whether the action applies to THIS row. Decides the button on the detail page and on each
   * list row, and is evaluated again on the server before the handler runs — a hidden button is
   * not an authorization: `X_ADMIN_ACTION_NOT_APPLICABLE`. The row it reads carries no sealed
   * column. Absent: the action applies to every row.
   */
  readonly when?: (row: AdminRow) => boolean;
  /**
   * In the list's batch bar: run once per selected row through the same gate as the button, each
   * row audited, the answer counting done, refused and failed. `true` runs every batch inline;
   * `{ threshold }` queues a selection larger than that as one job per chunk.
   */
  readonly batch?: true | AdminBatchOptions;
  /**
   * The batch bar's "all matching" as ONE set-based call instead of a walk of rows: handed the
   * list's own `where` — row scope, then scope, then filters — it changes what matches and answers
   * how many it changed and how many still match. For a store with a bounded bulk verb of its own
   * (the jobs operator's `requeueMany`). Decided and audited once, for the set; the per-row gate is
   * not asked per row, so the verb's own predicate is where `when` holds. A checked selection
   * still runs row by row through `handle`. Requires `batch`.
   */
  readonly matching?: (args: {
    readonly where: readonly AdminFilter[];
    readonly input: Input;
    readonly ctx: AdminActionCtx;
  }) => Promise<AdminMatchingResult>;
  handle(args: { input: Input; ctx: AdminActionCtx }): Promise<Output>;
}

/** A registered `job` as an AI pane is told about it (`ai-panes.ts`) — `describeJobs()` output. */
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

/**
 * A row as something DRAWN or DECIDED on reads it: its enumerable values, minus every sealed
 * column. A repository row keeps a sealed property off its enumerable set already; a hand-written
 * `repo:` may not, so the names are dropped explicitly — a computed cell is rendered and an
 * action's `when` is evaluated per row, and a sealed value reaches neither.
 */
export function computedRow(row: AdminRow, sealed: readonly string[]): AdminRow {
  return Object.fromEntries(Object.entries(row).filter(([key]) => !sealed.includes(key)));
}
