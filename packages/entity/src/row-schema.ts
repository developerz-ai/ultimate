// `entity.$schema` — the whole row as a `t`-compatible schema, branded with the entity's record
// projection. The brand is what lets `rowsOf` find a row inside any output shape, so it has to
// survive every wrapper a row can be put in: containers keep the child node by reference, and the
// five methods that COPY a node are re-branded here rather than in `@ultimat3/schema`.

import { renderThrowable } from '@ultimat3/core';
import { fail, makeSchema, pass, type Schema, type SchemaNode } from '@ultimat3/schema';
import {
  brandNode,
  createProjection,
  type ProjectionIdentity,
  type RecordProjection,
} from './record-projection';
import type { AnyColumn } from './types';
import { columnNode } from './view';

/**
 * Re-brands whatever a copying method returns. `nullable()`, `optional()`, `default()`,
 * `describe()` and `refine()` each build a fresh node by spreading this one, and a spread drops a
 * non-enumerable symbol — so without this, `t.nullable(posts.$schema)` would be a row nobody
 * recognises. `refine()` keeps the brand because it keeps the shape; `.pick()` is not here
 * because an entity row schema has none, and a `t.object` that does builds an unbranded node.
 */
const branded = <In, Out>(
  schema: Schema<In, Out>,
  projection: RecordProjection,
): Schema<In, Out> => {
  brandNode(schema.node, projection);
  return {
    ...schema,
    optional: () => branded(schema.optional(), projection),
    nullable: () => branded(schema.nullable(), projection),
    default: (value) => branded(schema.default(value), projection),
    describe: (description) => branded(schema.describe(description), projection),
    refine: (refinement) => branded(schema.refine(refinement), projection),
  };
};

/**
 * The row schema for one entity. Validation IS `$parse` — defaults filled, every column parsed —
 * so `$schema` and `$parse` can never disagree about what a row is. A refusal is rendered with
 * `renderThrowable`, never `instanceof`/`String()`: a column parser is app-reachable and may throw
 * anything, and a second `TypeError` out of a validator is the one outcome a validator may not have.
 */
export const rowSchema = <Row>(
  identity: ProjectionIdentity,
  columns: readonly (readonly [string, AnyColumn])[],
  parse: (value: unknown) => Row,
): Schema<unknown, Row> => {
  const node: SchemaNode = {
    kind: 'object',
    properties: Object.fromEntries(columns.map(([key, column]) => [key, columnNode(column)])),
  };
  const projection = createProjection(identity, node);
  const schema = makeSchema<unknown, Row>(node, (value, path) => {
    try {
      return pass(parse(value));
    } catch (error) {
      return fail(path, renderThrowable(error));
    }
  });
  return branded(schema, projection);
};
