// `seedGraph(entities, { tenants, perTable, seed })`: rows for every table, in an order every foreign
// key accepts, each child pointing at a parent of its OWN tenant, every value storable and every
// declared rule kept. Pure: it returns the plan, `insertSeedGraph` writes it. Same seed, same bytes.

import { finiteCount, finiteOption, fnv1a } from '@ultimat3/core';
import type { ReferenceDescription } from '@ultimat3/entity';
import { DEFAULT_SEED, seededUuid } from './determinism';
import { seedGraphUnsatisfied } from './seed-graph-error';
import { edgeKey, insertOrder } from './seed-graph-order';
import type {
  SeedCanary,
  SeedGraph,
  SeedGraphOptions,
  SeedRow,
  SeedUpdate,
} from './seed-graph-plan';
import { type RowProblem, solveRow, uniqueKey } from './seed-graph-row';
import { type EntityShape, type SeedEntity, shapeOf } from './seed-graph-shape';
import { candidatesFor, storable } from './seed-graph-values';

interface Placed {
  readonly tenant: string | null;
  readonly row: Record<string, unknown>;
  readonly index: number;
}

const streamSeed = (seed: number, name: string): number => fnv1a(`${seed}:${name}`) || 1;

const rotate = <T>(values: readonly T[], by: number): T[] =>
  values.map((_, i) => values[(i + by) % values.length] as T);

const keyOf = (entity: SeedEntity, row: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(entity.$primaryKey.map((property) => [property, row[property]]));

/**
 * Every entity whose rows belong to one tenant: a tenant column, a tenant root, or — with neither —
 * a reference path to one that is not cut by `shared`. The last kind is seeded per tenant under
 * its own tenant's parent, so the tenant proof has a row of each instance to attack it through.
 */
function ownedByTenant(
  shapes: ReadonlyMap<string, EntityShape>,
  roots: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const owned = new Set<string>();
  for (const shape of shapes.values()) {
    if (roots.has(shape.name) || shape.entity.$tenantColumn !== null) owned.add(shape.name);
  }
  // A fixpoint over references: a grandchild is owned through its owned child.
  for (let grew = true; grew; ) {
    grew = false;
    for (const shape of shapes.values()) {
      if (owned.has(shape.name) || shape.entity.$describe().shared !== undefined) continue;
      const reaches = [...shape.references.values()].some(
        (reference) => reference.targetEntity !== shape.name && owned.has(reference.targetEntity),
      );
      if (reaches) {
        owned.add(shape.name);
        grew = true;
      }
    }
  }
  return owned;
}

export function seedGraph(
  entities: Readonly<Record<string, SeedEntity>>,
  options: SeedGraphOptions = {},
): SeedGraph {
  const seed = finiteOption('seedGraph', 'seed', options.seed ?? DEFAULT_SEED);
  const tenantCount = finiteCount('seedGraph', 'tenants', options.tenants ?? 2, 1);
  const perTable = finiteCount('seedGraph', 'perTable', options.perTable ?? 3, 1);
  const shapes = new Map(Object.values(entities).map((entity) => [entity.$name, shapeOf(entity)]));
  const { order, deferred } = insertOrder(
    [...shapes.values()].map((shape) => ({
      name: shape.name,
      references: [...shape.references.values()],
    })),
  );
  const tenantStream = seededUuid(streamSeed(seed, '$tenants'));
  const tenants = Array.from({ length: tenantCount }, () => tenantStream());
  // The entity a tenant column points at holds ONE row per tenant, keyed by the tenant itself.
  const roots = new Map<string, string>();
  for (const shape of shapes.values()) {
    const tenantColumn = shape.entity.$tenantColumn;
    const reference = tenantColumn === null ? undefined : shape.references.get(tenantColumn);
    if (reference !== undefined && reference.targetEntity !== shape.name) {
      roots.set(reference.targetEntity, reference.targetProperty);
    }
  }
  const owned = ownedByTenant(shapes, roots);
  const scoped = (name: string): boolean => owned.has(name);
  for (const factory of Object.values(options.factories ?? {})) factory.reset();

  const placed = new Map<string, Placed[]>();
  const parentValues = (
    reference: ReferenceDescription,
    tenant: string | null,
    index: number,
  ): unknown[] => {
    if (!shapes.has(reference.targetEntity)) return reference.nullable ? [null] : [];
    const pool = (placed.get(reference.targetEntity) ?? []).filter(
      (parent) => tenant === null || !scoped(reference.targetEntity) || parent.tenant === tenant,
    );
    const values =
      pool.length === 0 ? [] : rotate(pool, index).map((p) => p.row[reference.targetProperty]);
    return reference.nullable ? [...values, null] : values;
  };
  const refuseEmpty = (shape: EntityShape, property: string, tenant: string | null): never => {
    const reference = shape.references.get(property);
    throw seedGraphUnsatisfied({
      entity: shape.name,
      what:
        reference === undefined
          ? `no generated value is storable in ${property} — its column refuses every one`
          : !shapes.has(reference.targetEntity)
            ? `${property} references ${reference.targetEntity}, which is not in the set seeded — pass it too`
            : `${property} references ${reference.targetEntity}, which has no row${tenant === null ? '' : ' in the same tenant'} to point at`,
      columns: [property],
    });
  };

  const inserts: SeedRow[] = [];
  const canaries: SeedCanary[] = [];
  for (const name of order) {
    const shape = shapes.get(name) as EntityShape;
    const entity = shape.entity;
    const stream = seededUuid(streamSeed(seed, name));
    const factory = options.factories?.[name];
    const rows: Placed[] = [];
    placed.set(name, rows);
    const taken = shape.uniques.map(() => new Set<string>());
    const rootProperty = roots.get(name);
    const buckets: readonly (string | null)[] = scoped(name) ? tenants : [null];
    let ordinal = 0;
    for (const [bucket, tenant] of buckets.entries()) {
      const size = rootProperty === undefined ? perTable : 1;
      for (let index = 0; index < size; index += 1) {
        ordinal += 1;
        const canary = stream().replace(/-/g, '').slice(0, 10);
        const built: Readonly<Record<string, unknown>> =
          factory === undefined ? {} : { ...factory.build() };
        const columns = shape.columns.map(([property, column], position) => {
          const reference = shape.references.get(property);
          // The tenant key points at a root row only when the root is in the set: refused like any
          // other reference to an entity this graph does not seed.
          const candidates =
            property === entity.$tenantColumn &&
            reference !== undefined &&
            !shapes.has(reference.targetEntity)
              ? []
              : property === entity.$tenantColumn || property === rootProperty
                ? [tenant]
                : property === shape.softDelete && !Object.hasOwn(built, property)
                  ? [null]
                  : reference !== undefined
                    ? deferred.has(edgeKey(name, property))
                      ? [null]
                      : parentValues(reference, tenant, index)
                    : Object.hasOwn(built, property)
                      ? storable(column, [built[property]])
                      : candidatesFor(property, column, {
                          ordinal,
                          canary,
                          position,
                          uuid: stream,
                        });
          return [
            property,
            candidates.length === 0 ? refuseEmpty(shape, property, tenant) : candidates,
          ] as const;
        });
        const problem: RowProblem = {
          columns,
          checks: shape.checks,
          uniques: shape.uniques,
          taken,
        };
        const solved = solveRow(problem);
        if (!solved.ok) {
          // A table whose unique values run out is full, not broken — as long as EVERY tenant holds a
          // row: a tenant left empty would leave its own children no parent to point at.
          if (solved.capacity && index > 0) break;
          throw seedGraphUnsatisfied({
            entity: name,
            what:
              solved.capacity && rows.length > 0
                ? `${solved.broken.join(', ')} runs out of values before tenant ${bucket + 1} of ${buckets.length} holds a row — it is unique across the table, not per tenant`
                : `no generated row keeps ${solved.broken.join(', ')}`,
            columns: solved.properties,
          });
        }
        const row = { ...solved.row };
        shape.uniques.forEach((set, i) => {
          const key = uniqueKey(row, set);
          if (key !== undefined) taken[i]?.add(key);
        });
        rows.push({ tenant, row, index });
        inserts.push({ entity: name, table: entity.$table, tenant, row: { ...row } });
        canaries.push({
          entity: name,
          tenant,
          key: keyOf(entity, row),
          marker: canary,
          columns: Object.keys(row).filter(
            (p) => typeof row[p] === 'string' && String(row[p]).includes(canary),
          ),
        });
      }
    }
  }

  const updates: SeedUpdate[] = [];
  for (const name of order) {
    const shape = shapes.get(name) as EntityShape;
    const later = shape.columns.filter(([property]) => deferred.has(edgeKey(name, property)));
    if (later.length === 0) continue;
    for (const { tenant, row, index } of placed.get(name) ?? []) {
      const columns = shape.columns.map(([property]) => {
        const reference = shape.references.get(property);
        return reference !== undefined && deferred.has(edgeKey(name, property))
          ? ([property, parentValues(reference, tenant, index)] as const)
          : ([property, [row[property]]] as const);
      });
      const solved = solveRow({ columns, checks: shape.checks, uniques: [], taken: [] });
      if (!solved.ok) {
        throw seedGraphUnsatisfied({
          entity: name,
          what: `the key set after insert to close a cycle breaks ${solved.broken.join(', ')}`,
          columns: solved.properties,
        });
      }
      const patch = Object.fromEntries(
        later.flatMap(([property]) =>
          solved.row[property] === null ? [] : [[property, solved.row[property]]],
        ),
      );
      if (Object.keys(patch).length === 0) continue;
      Object.assign(row, patch);
      updates.push({ entity: name, tenant, key: keyOf(shape.entity, row), patch });
    }
  }
  return { seed, tenants, order, inserts, updates, canaries };
}
