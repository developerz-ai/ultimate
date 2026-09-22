// Which values in an output are entity rows — read off the output SCHEMA, never declared beside it
// (axiom 2). `hasEntityRows` answers statically and is memoised per node; `rowsOf` walks only the
// branches that can hold a row, so an output with none costs one WeakMap read per call.

import type { Row } from '@ultimat3/core';
import { isSchemaNode, nodeOf, type SchemaNode } from '@ultimat3/schema';
import { projectionOf, type RecordProjection } from './record-projection';

/** Children in the IR that can hold a value: object fields, array items, record values, arms. */
const childrenOf = (node: SchemaNode): readonly SchemaNode[] => [
  ...Object.values(node.properties ?? {}),
  ...(node.items === undefined ? [] : [node.items]),
  ...(node.valueNode === undefined ? [] : [node.valueNode]),
  ...(node.anyOf ?? []),
];

const holdsRows = new WeakMap<SchemaNode, boolean>();

const containsBrand = (node: SchemaNode): boolean => {
  const known = holdsRows.get(node);
  if (known !== undefined) return known;
  // Seeded `false` before recursing, so a node reachable from itself ends rather than overflows.
  holdsRows.set(node, false);
  const answer = projectionOf(node) !== undefined || childrenOf(node).some(containsBrand);
  holdsRows.set(node, answer);
  return answer;
};

/** A schema object (anything carrying `node`) or a bare node; anything else has no rows. */
const rootOf = (schema: unknown): SchemaNode | undefined =>
  nodeOf(schema) ?? (isSchemaNode(schema) ? schema : undefined);

/** Does this output schema reference any entity row, at any depth? Static — no value needed. */
export const hasEntityRows = (schema: unknown): boolean => {
  const root = rootOf(schema);
  return root !== undefined && containsBrand(root);
};

/**
 * Every entity projection an output schema can carry, one per record type, in first-seen order.
 * Static, like `hasEntityRows`: a branded node is a row and its columns are never walked. What a
 * caller needing the ENTITIES rather than the rows reads — `@ultimat3/action`'s mutator clock check.
 */
export const projectionsIn = (schema: unknown): readonly RecordProjection[] => {
  const root = rootOf(schema);
  if (root === undefined) return [];
  const found = new Map<string, RecordProjection>();
  const seen = new Set<SchemaNode>();
  const visit = (node: SchemaNode): void => {
    if (seen.has(node) || !containsBrand(node)) return;
    seen.add(node);
    const projection = projectionOf(node);
    if (projection !== undefined) {
      if (!found.has(projection.type)) found.set(projection.type, projection);
      return;
    }
    for (const child of childrenOf(node)) visit(child);
  };
  visit(root);
  return [...found.values()];
};

const isObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Inside a union the IR cannot say which arm a value took, so a branded arm claims the value only
 * when it carries every column of that row as an OWN key — `$parse` writes every column, `null`
 * included, so a real row always does. Outside a union the output schema already validated the
 * value, and it is taken as the row it was declared to be.
 */
const fits = (projection: RecordProjection, value: Readonly<Record<string, unknown>>): boolean =>
  Object.keys(projection.schema.properties ?? {}).every((column) => Object.hasOwn(value, column));

type Found = Map<string, Map<string, Row>>;

const collect = (found: Found, projection: RecordProjection, row: Row): void => {
  const byKey = found.get(projection.type) ?? new Map<string, Row>();
  found.set(projection.type, byKey);
  const key = projection.key(row);
  // First sighting wins: one record shown twice in a response is one record, not two writes.
  if (!byKey.has(key)) byKey.set(key, row);
};

const walk = (node: SchemaNode, value: unknown, found: Found, inUnion: boolean): void => {
  if (value === null || value === undefined || !containsBrand(node)) return;
  const projection = projectionOf(node);
  if (projection !== undefined) {
    // A row's own columns are never walked: a column node carries no brand, and a `json()` value
    // shaped like a row is data, not a record.
    if (isObject(value) && (!inUnion || fits(projection, value))) collect(found, projection, value);
    return;
  }
  if (node.kind === 'array' && node.items !== undefined && Array.isArray(value)) {
    for (const item of value) walk(node.items, item, found, inUnion);
  } else if (node.kind === 'object' && node.properties !== undefined && isObject(value)) {
    for (const [key, child] of Object.entries(node.properties)) {
      if (Object.hasOwn(value, key)) walk(child, value[key], found, inUnion);
    }
  } else if (node.kind === 'record' && node.valueNode !== undefined && isObject(value)) {
    for (const entry of Object.values(value)) walk(node.valueNode, entry, found, inUnion);
  } else if (node.kind === 'union') {
    for (const arm of node.anyOf ?? []) walk(arm, value, found, true);
  }
};

/** Keyed by record key, null-prototype: a key is data, and `'__proto__'` must stay a key. */
export type RecordsByKey = Readonly<Record<string, Row>>;

/** Keyed by record type, then by record key — the shape the record envelope carries on the wire. */
export type RecordsByType = Readonly<Record<string, RecordsByKey>>;

const nullProto = <V>(entries: Iterable<readonly [string, V]>): Readonly<Record<string, V>> => {
  const out = Object.create(null) as Record<string, V>;
  for (const [key, value] of entries) out[key] = value;
  return out;
};

/**
 * Every entity row in `value`, grouped by record type and keyed by record key — `{}` when the
 * schema references none. The KEY travels because the browser cannot compute it: it would have to
 * import the app's `entity()` declarations. The rows are the SAME objects the handler returned,
 * one per key; a row with no key is `X_RECORD_KEY_MISSING`, because a keyless record would
 * overwrite every other keyless one.
 */
export const rowsOf = (schema: unknown, value: unknown): RecordsByType => {
  const root = rootOf(schema);
  if (root === undefined || !containsBrand(root)) return nullProto([]);
  const found: Found = new Map();
  walk(root, value, found, false);
  return nullProto([...found].map(([type, byKey]) => [type, nullProto(byKey)] as const));
};
