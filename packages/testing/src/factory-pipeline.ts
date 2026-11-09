// One row's pipeline, written ONCE for both strategies: a generator that yields what it needs — a
// parent, a child, a write, a callback — and lets the caller decide how. `build()` answers each
// yield synchronously in memory, `create()` awaits the database; the order of every step, and so
// every seeded draw, is the same in both.

import { referencedBy } from './factory-associations';
import type {
  BelongsTo,
  EntityLike,
  FactoryContext,
  FactoryIds,
  FactoryLike,
  HasMany,
  Trait,
} from './factory-types';

type Bag = Record<string, unknown>;

/** A factory's declaration with its types erased: what the pipeline runs. */
export interface FactorySpec {
  readonly entity: EntityLike;
  readonly defaults: (index: number, ids: FactoryIds, transient: Bag) => object;
  readonly traits: Readonly<Record<string, Trait<object, Bag>>>;
  readonly transient: Readonly<Bag>;
  readonly belongsTo: readonly (readonly [string, BelongsTo<object, object, string>])[];
  readonly hasMany: readonly (readonly [string, HasMany<object, object, string>])[];
  readonly afterBuild: readonly ((row: object, context: FactoryContext<Bag>) => void)[];
  readonly afterCreate: readonly ((row: object, context: FactoryContext<Bag>) => unknown)[];
}

export type Step =
  | { readonly kind: 'parent' | 'child'; readonly factory: FactoryLike; readonly over: object }
  | { readonly kind: 'persist'; readonly row: object }
  | { readonly kind: 'callback'; readonly run: () => unknown };

interface Split {
  readonly columns: Bag;
  readonly transient: Bag;
  readonly parents: ReadonlyMap<string, Bag>;
  readonly many: ReadonlyMap<string, number | readonly object[]>;
}

/** An override key is a transient, a `belongsTo` name, a `hasMany` name — or a column. */
function split(spec: FactorySpec, over: object): Split {
  const columns: Bag = {};
  const transient: Bag = { ...spec.transient };
  const parents = new Map<string, Bag>();
  const many = new Map<string, number | readonly object[]>();
  const parentNames = new Set(spec.belongsTo.map(([name]) => name));
  const manyNames = new Set(spec.hasMany.map(([name]) => name));
  for (const [key, value] of Object.entries(over)) {
    if (Object.hasOwn(spec.transient, key)) transient[key] = value;
    else if (parentNames.has(key)) parents.set(key, value as Bag);
    else if (manyNames.has(key)) many.set(key, value as number | readonly object[]);
    else columns[key] = value;
  }
  return { columns, transient, parents, many };
}

/** Traits left to right, then the call's columns: the patch every association must respect. */
function patchOf(
  spec: FactorySpec,
  applied: readonly string[],
  parts: Split,
  index: number,
  ids: FactoryIds,
): Bag {
  let patch: Bag = {};
  for (const name of applied) {
    const trait = spec.traits[name];
    patch = {
      ...patch,
      ...(typeof trait === 'function' ? trait(index, ids, parts.transient) : trait),
    };
  }
  return { ...patch, ...parts.columns };
}

/** A row's tenant as its own entity stores it: the tenant column's value, when it has one. */
const tenantOf = (entity: EntityLike, row: Bag): unknown => {
  const column = entity.$tenantColumn ?? null;
  return column === null ? undefined : row[column];
};

/**
 * The association on the tenant column first: its parent fixes the tenant, and every other parent
 * is then made IN that tenant — a comment's post and its org, never two orgs.
 */
const tenantFirst = (spec: FactorySpec): FactorySpec['belongsTo'] => {
  const column = spec.entity.$tenantColumn ?? null;
  return [...spec.belongsTo].sort(
    ([, a], [, b]) => Number(b.foreignKey === column) - Number(a.foreignKey === column),
  );
};

export function* rowSteps(
  spec: FactorySpec,
  applied: readonly string[],
  over: object,
  strategy: 'build' | 'create',
  context: { readonly index: number; readonly ids: FactoryIds },
): Generator<Step, object, unknown> {
  const parts = split(spec, over);
  const { index, ids } = context;
  const ctx: FactoryContext<Bag> = { index, ids, transient: parts.transient };
  const patch = patchOf(spec, applied, parts, index, ids);
  const row: Bag = { ...spec.defaults(index, ids, parts.transient), ...patch };
  const tenantColumn = spec.entity.$tenantColumn ?? null;
  let tenant =
    tenantColumn !== null && Object.hasOwn(patch, tenantColumn) ? patch[tenantColumn] : undefined;
  // A parent the CALLER handed over decides the tenant before anything is made: resolved first, the
  // tenant column's own association made a new org and keyed the row to a post in another one.
  for (const [name, link] of spec.belongsTo) {
    const given = parts.parents.get(name);
    if (tenant !== undefined || given === undefined || link.foreignKey === tenantColumn) continue;
    tenant = tenantOf(link.parent.entity, given);
  }
  for (const [name, link] of tenantFirst(spec)) {
    const key = link.foreignKey;
    let parent = parts.parents.get(name);
    if (parent === undefined) {
      // A key the caller (or a trait) supplied makes no parent nobody asked for.
      if (Object.hasOwn(patch, key)) continue;
      // The tenant is already known — the tenant column takes it, and no second tenant is made.
      if (key === tenantColumn && tenant !== undefined) {
        row[key] = tenant;
        continue;
      }
      const parentTenant = link.parent.entity.$tenantColumn ?? null;
      const parentOver =
        tenant !== undefined && parentTenant !== null ? { [parentTenant]: tenant } : {};
      parent = (yield { kind: 'parent', factory: link.parent, over: parentOver }) as Bag;
    }
    row[key] = parent[referencedBy(spec.entity, key, link.references)];
    if (key === tenantColumn) tenant = row[key];
    else tenant ??= tenantOf(link.parent.entity, parent);
  }
  if (tenantColumn !== null && tenant !== undefined && !Object.hasOwn(patch, tenantColumn)) {
    row[tenantColumn] = tenant;
  }
  for (const callback of spec.afterBuild) callback(row, ctx);
  const stored = strategy === 'create' ? ((yield { kind: 'persist', row }) as Bag) : row;
  const children: Record<string, readonly object[]> = {};
  for (const [name, link] of spec.hasMany) {
    const asked = parts.many.get(name) ?? link.count;
    const list = typeof asked === 'number' ? Array.from({ length: asked }, () => ({})) : asked;
    const value = stored[referencedBy(link.child.entity, link.foreignKey, link.references)];
    const childTenant = link.child.entity.$tenantColumn ?? null;
    const ownTenant = tenantOf(spec.entity, stored);
    const follows =
      childTenant !== null && childTenant !== link.foreignKey && ownTenant !== undefined
        ? { [childTenant]: ownTenant }
        : {};
    const made: object[] = [];
    for (const one of list) {
      const childOver = { [link.foreignKey]: value, ...follows, ...one };
      made.push((yield { kind: 'child', factory: link.child, over: childOver }) as object);
    }
    children[name] = made;
  }
  // The children ride NON-enumerable: the answer is still the row as stored — `toEqual` against a
  // read of the table holds, a spread or an insert of it carries no `comments` column — and
  // `post.comments` is there for the test that asked for them.
  const result: object = { ...stored };
  for (const [name, made] of Object.entries(children)) {
    Object.defineProperty(result, name, { value: made, enumerable: false });
  }
  if (strategy === 'create') {
    for (const callback of spec.afterCreate) {
      yield { kind: 'callback', run: () => callback(result, ctx) };
    }
  }
  return result;
}

/** `attributesFor`: the input shape — no key of its own, no parent key, no transient. */
export function attributesOf(
  spec: FactorySpec,
  applied: readonly string[],
  over: object,
  context: { readonly index: number; readonly ids: FactoryIds },
): object {
  const parts = split(spec, over);
  const row: Bag = {
    ...spec.defaults(context.index, context.ids, parts.transient),
    ...patchOf(spec, applied, parts, context.index, context.ids),
  };
  for (const key of spec.entity.$primaryKey ?? ['id']) delete row[key];
  for (const [, link] of spec.belongsTo) delete row[link.foreignKey];
  return row;
}
