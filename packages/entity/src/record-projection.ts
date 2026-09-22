// An entity's client projection — record type, record key, row node, persist — and the brand that
// carries it on the entity's row schema. Value-light on purpose: the browser store imports this,
// and nothing here may reach the Postgres driver.

import type { Row } from '@ultimat3/core';
import { isSchemaNode, type SchemaNode } from '@ultimat3/schema';
import { invariantViolated } from './entity-error';
import { recordKeyOf } from './record-key';

/**
 * `Symbol.for`, not `Symbol()`: islands are separate bundles, so a row schema declared in one and
 * walked in another holds a brand minted by a different copy of this module. Only the registry key
 * is the same symbol in both.
 */
export const ENTITY_BRAND: unique symbol = Symbol.for('ultimate.entity');

export interface RecordProjection {
  /** The wire name — the entity's name, the framework's key for it everywhere else too. */
  readonly type: string;
  /**
   * The physical relation. A changefeed and a snapshot speak TABLES; `recordTypeForTable` is how
   * they reach `type`, and this is the same fact read from the other end.
   */
  readonly table: string;
  /** Primary key → string, in declared order. Throws `X_RECORD_KEY_MISSING`. */
  readonly key: (row: Row) => string;
  /** The row's schema IR — JSON, so a store can put it on disk beside the rows. */
  readonly schema: SchemaNode;
  /**
   * Whether the client keeps this entity's records on disk — `entity(name, { persist: true })`,
   * default `false`. Realtime's persister reads it here, never off the declaration.
   */
  readonly persist: boolean;
}

/** What `entity()` hands the projection: everything but the row node, which the schema builds. */
export interface ProjectionIdentity {
  readonly name: string;
  readonly table: string;
  readonly primaryKey: readonly string[];
  readonly persist: boolean;
}

/** Built once per `entity()`, frozen: the brand, `recordProjection` and `rowsOf` share one object. */
export const createProjection = (
  { name, table, primaryKey, persist }: ProjectionIdentity,
  schema: SchemaNode,
): RecordProjection =>
  Object.freeze({ type: name, table, key: recordKeyOf(name, primaryKey), schema, persist });

/**
 * The projection a schema node is branded with, or `undefined`. Own and non-enumerable: an
 * enumerable symbol would ride every spread and `toEqual` of the IR, and an inherited one would
 * brand every node built from a branded prototype.
 */
export const projectionOf = (node: unknown): RecordProjection | undefined => {
  if (!isSchemaNode(node) || !Object.hasOwn(node, ENTITY_BRAND)) return undefined;
  return (node as { readonly [ENTITY_BRAND]?: RecordProjection })[ENTITY_BRAND];
};

/** Brands `node` in place. Called by the row schema on its own node and on each wrapper's. */
export const brandNode = (node: SchemaNode, projection: RecordProjection): void => {
  Object.defineProperty(node, ENTITY_BRAND, { value: projection, enumerable: false });
};

/** The structural slice of an entity this reads — so it never imports `entity.ts`. */
export interface ProjectedEntity {
  readonly $name: string;
  readonly $schema: { readonly node: SchemaNode };
}

/**
 * `recordProjection(posts)` — the one answer to "what is this entity on the client". Read off the
 * brand rather than rebuilt, so the store, the envelope and `rowsOf` hold the same object.
 */
export const recordProjection = (entity: ProjectedEntity): RecordProjection => {
  const projection = projectionOf(entity.$schema.node);
  // Every `entity()` brands its row schema, so absence means a hand-built lookalike: the type is
  // `EntityCore`, and the only way here without a brand is a cast.
  if (projection === undefined) {
    throw invariantViolated(
      entity.$name,
      '$schema',
      'carries no record brand; declare it with entity()',
    );
  }
  return projection;
};
