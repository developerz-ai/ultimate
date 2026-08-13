// Single responsibility: the eager preload. `preload('author')` is one extra
// `select … where <key> in (…)` over the values the page already carries, and its rows attached to
// that page under the relation's name — the declarative form of what a point lookup batches for
// itself, and the exact line an N+1 warning tells the reader to write.
//
// Nothing new is declared: the relation is the `references()` already written (`relations.ts`).
// The other table is read through the same driver this one came from, so a preload against the
// in-memory driver means what a preload against Postgres means.

import { keyOf, MAX_IDS_PER_STATEMENT, statementChunks } from './batch-read';
import { valueAt } from './cursor';
import type { EntityCore } from './entity';
import { EntityError } from './errors';
import type { Relation } from './relations';
import type { Repo } from './repo';
import type { Predicate } from './tenancy';

/** The other side of a relation: the entity, and where its rows live. */
export interface RelatedTable {
  readonly entity: EntityCore;
  readonly repo: Repo<unknown>;
}

/**
 * How one table reaches another. `database()` supplies it over the set it was declared with and
 * through the driver that set was given, so a preload reads rows from where this table's own rows
 * come from — and a table can no more preload an entity the set never named than it can be indexed
 * off `db` by one.
 */
export type RelatedTables = (entityName: string) => RelatedTable | undefined;

/**
 * Not `invariantViolated`: its fix opens `x entity explain`, which describes invariants nobody
 * wrote here. What repairs this is one edit to the `database()` call — a relation whose other end
 * is outside the set is a set that is missing an entity, and the preload declines rather than
 * reaching around the handle for it.
 */
const unreachable = (entityName: string, relation: Relation): EntityError =>
  new EntityError({
    code: 'X_INVARIANT_VIOLATED',
    cause: `${entityName}.preload('${relation.name}') reads ${relation.to}, which this table cannot reach — a table reads the entities its own database() call named`,
    fix: `x entities list --json   # then widen the database() call that built db.${entityName} to database({ ${entityName}, ${relation.to} }, options)`,
  });

/**
 * The tenant predicate the page was read under, carried onto the related read when BOTH entities
 * are scoped by a column of that same name. Never across two differently-named tenant columns: a
 * value that scopes one entity is a guess on another, and a guess here is a cross-tenant read.
 *
 * Both ends are checked, not just the target's. A source scoped by `workspaceId` may still carry
 * an ordinary `orgId` predicate of its own — a filter, not its tenancy — and matching on the
 * target's column name alone would lift that filter into the target's tenant scope and hand the
 * preload rows from a tenant nobody proved this reader owns.
 *
 * Carrying nothing is not a failure of this function — the related read builds its own plan, so
 * `assertScoped` refuses it there, in the words a caller can act on.
 */
const tenantScope = (
  source: EntityCore,
  target: EntityCore,
  where: readonly Predicate[],
): readonly Predicate[] => {
  const column = target.$tenantColumn;
  if (column === null || source.$tenantColumn !== column) return [];
  const carried = where.find((predicate) => predicate.column === column && predicate.op === 'eq');
  return carried === undefined ? [] : [carried];
};

/**
 * Every row on the other side, in as few statements as the bind count allows: one per 500 keys —
 * the bound a batched point read already lives under — and one more only when a page comes back
 * genuinely full. A `belongsTo` over a page of 50 is exactly one statement.
 *
 * The page loop is what keeps a `hasMany` honest: a relation with more rows than one page holds
 * costs another statement rather than silently returning the first page of them.
 */
const relatedRows = async (
  target: RelatedTable,
  relation: Relation,
  values: readonly unknown[],
  scope: readonly Predicate[],
): Promise<readonly unknown[]> => {
  const rows: unknown[] = [];
  for (const chunk of statementChunks(values)) {
    let cursor: string | null = null;
    do {
      const page = await target.repo.findMany({
        where: [{ column: relation.remoteKey, op: 'in', value: chunk }, ...scope],
        limit: MAX_IDS_PER_STATEMENT,
        cursor,
      });
      rows.push(...page.rows);
      cursor = page.nextCursor;
    } while (cursor !== null);
  }
  return rows;
};

/** Related rows filed under the key they attach to — in the order the read returned them. */
const indexed = async (
  target: RelatedTable,
  relation: Relation,
  kind: string,
  values: readonly unknown[],
  scope: readonly Predicate[],
): Promise<ReadonlyMap<string, readonly unknown[]>> => {
  const index = new Map<string, unknown[]>();
  if (values.length === 0) return index;
  const found = await relatedRows(target, relation, values, scope);
  for (const row of found) {
    const at = keyOf(kind, valueAt(row, relation.remoteKey));
    const bucket = index.get(at);
    if (bucket === undefined) index.set(at, [row]);
    else bucket.push(row);
  }
  return index;
};

/** The distinct keys a page carried, spelled as the batch spells them. A null key is not a key. */
const distinctKeys = (kind: string, keys: readonly unknown[]): readonly unknown[] => {
  const seen = new Set<string>();
  const values: unknown[] = [];
  for (const key of keys) {
    if (key === null || key === undefined) continue;
    const at = keyOf(kind, key);
    if (seen.has(at)) continue;
    seen.add(at);
    values.push(key);
  }
  return values;
};

export interface PreloadRead<Source> {
  readonly entity: EntityCore<Source>;
  /** `undefined` for a table built by hand — `tableFor(entity, repo)` reaches no other table. */
  readonly related: RelatedTables | undefined;
  readonly relations: readonly Relation[];
  /** The page's own predicates: what the related read inherits its tenant scope from. */
  readonly where: readonly Predicate[];
}

/**
 * The page, with every named relation attached to it. `source` carries the key values (a
 * projection may have dropped them from the rows the caller sees) and `rows` are the rows the
 * caller gets, in the same order — the attachment is by position, so the two are always one page.
 *
 * A relation resolves to a row or `null` when it is a `belongsTo` and to an array when it is a
 * `hasMany`, always present: "this post has no author" and "nobody preloaded the author" must not
 * read the same at the call site. Relations resolve concurrently — two `preload()` calls are two
 * statements in flight, never one after the other — and attach in the order they were named.
 */
export const preloaded = async <Source, Row>(
  read: PreloadRead<Source>,
  source: readonly Source[],
  rows: readonly Row[],
): Promise<readonly Row[]> => {
  if (read.relations.length === 0 || rows.length === 0) return rows;
  const resolved = await Promise.all(
    read.relations.map(async (relation) => {
      const target = read.related?.(relation.to);
      if (target === undefined) throw unreachable(read.entity.$name, relation);
      // The declaring column's own kind: a foreign key mirrors the key it points at, so both ends
      // of the edge are spelled the way a batched point read already spells them.
      const kind = read.entity.$columns[relation.localKey]?.$meta.kind ?? '';
      const keys = source.map((row) => valueAt(row, relation.localKey));
      const scope = tenantScope(read.entity, target.entity, read.where);
      const index = await indexed(target, relation, kind, distinctKeys(kind, keys), scope);
      return { relation, kind, keys, index };
    }),
  );
  // A copy per row: the in-memory driver hands back the row it stores, and attaching to that one
  // would write a relation into the table itself.
  const attached = rows.map((row) => ({ ...row }) as Record<string, unknown>);
  for (const { relation, kind, keys, index } of resolved) {
    for (const [position, row] of attached.entries()) {
      const key = keys[position];
      const found = key === null || key === undefined ? undefined : index.get(keyOf(kind, key));
      row[relation.name] = relation.kind === 'hasMany' ? (found ?? []) : (found?.[0] ?? null);
    }
  }
  // Built from the caller's own rows, one property added per relation named — which is exactly
  // what `Row & { [name]: unknown }` says at the call site.
  return attached as readonly Row[];
};
