// One JSON Schema (OpenAPI 3.0 or 3.1) to a `ClientType`: `$ref`, objects, arrays, enums, `const`,
// `oneOf`/`anyOf`, `allOf`, nullable. A keyword that would change a value's shape and is not one of
// those is refused with its pointer; a keyword that only narrows a value is not a shape and is read
// past. Named components are compiled on first reach, so a recursive `$ref` is a name, not a loop.

import type { ClientField, ClientObject, ClientType } from './openapi-compile-ir';
import { objectAt, own, pointerJoin, unsupported } from './openapi-refuse';

const SHAPE_KEYS = new Set([
  'type',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'enum',
  'const',
  'oneOf',
  'anyOf',
  'allOf',
  '$ref',
  'nullable',
]);

/** Annotations and value narrowings: true of a value, never a different shape for it. */
const NARROWING_KEYS = new Set([
  '$schema',
  '$id',
  '$comment',
  '$defs',
  'title',
  'description',
  'default',
  'example',
  'examples',
  'deprecated',
  'readOnly',
  'writeOnly',
  'format',
  'minLength',
  'maxLength',
  'pattern',
  'minimum',
  'maximum',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'multipleOf',
  'minItems',
  'maxItems',
  'uniqueItems',
  'minProperties',
  'maxProperties',
  'propertyNames',
  'discriminator',
  'externalDocs',
  'xml',
  'contentMediaType',
  'contentEncoding',
]);

const COMPONENT_REF = '#/components/schemas/';
const UNKNOWN: ClientType = { kind: 'unknown' };
const NULL: ClientType = { kind: 'null' };

/** The component table the compiler fills as operations reach it. */
export interface SchemaScope {
  readonly components: Readonly<Record<string, unknown>>;
  /** Component name → its compiled type; `null` while that component is being compiled. */
  readonly compiled: Map<string, ClientType | null>;
}

/** `review-draft.input` → `ReviewDraftInput`: a TypeScript identifier, case kept inside a word. */
export function typeName(name: string): string {
  const words = name.split(/[^A-Za-z0-9]+/).filter((word) => word.length > 0);
  const joined = words.map((word) => `${word[0]?.toUpperCase() ?? ''}${word.slice(1)}`).join('');
  return /^[0-9]/.test(joined) || joined === '' ? `T${joined}` : joined;
}

/** A union with nested unions flattened and duplicates dropped; one member is that member. */
export function unionOf(members: readonly ClientType[]): ClientType {
  const seen = new Map<string, ClientType>();
  for (const member of members.flatMap((m) => (m.kind === 'union' ? m.members : [m]))) {
    seen.set(JSON.stringify(member), member);
  }
  const unique = [...seen.values()];
  if (unique.some((member) => member.kind === 'unknown')) return UNKNOWN;
  return unique.length === 1 ? (unique[0] as ClientType) : { kind: 'union', members: unique };
}

function reachComponent(scope: SchemaScope, ref: string, pointer: string): ClientType {
  if (!ref.startsWith(COMPONENT_REF)) return refuse(pointer, `the $ref ${ref}`);
  const name = ref.slice(COMPONENT_REF.length).replace(/~1/g, '/').replace(/~0/g, '~');
  const target = own(scope.components, name);
  if (target === undefined) return refuse(pointer, `a $ref to a missing component (${ref})`);
  if (!scope.compiled.has(name)) {
    scope.compiled.set(name, null);
    scope.compiled.set(name, compileSchema(scope, target, `${COMPONENT_REF}${name}`));
  }
  return { kind: 'ref', name };
}

function refuse(pointer: string, construct: string): never {
  throw unsupported(pointer, construct);
}

/** A type as an object to merge into, a `$ref` followed; anything else is refused. */
function asObject(scope: SchemaScope, type: ClientType, pointer: string): ClientObject {
  if (type.kind === 'object') return type;
  if (type.kind === 'ref') {
    const target = scope.compiled.get(type.name);
    if (target === null) return refuse(pointer, 'an allOf through a recursive $ref');
    if (target !== undefined) return asObject(scope, target, pointer);
  }
  return refuse(pointer, `an allOf or oneOf member that is not an object (${type.kind})`);
}

/** Field by field, the later declaration winning: an `allOf` narrows what it extends. */
function mergeObjects(objects: readonly ClientObject[]): ClientObject {
  const fields = new Map<string, ClientField>();
  for (const object of objects) {
    for (const field of object.fields) {
      const before = fields.get(field.name);
      fields.set(field.name, { ...field, required: field.required || before?.required === true });
    }
  }
  return { kind: 'object', fields: [...fields.values()] };
}

function objectOf(
  scope: SchemaScope,
  schema: Readonly<Record<string, unknown>>,
  pointer: string,
): ClientType {
  const properties = objectAt(schema['properties']) ?? {};
  const required = new Set(Array.isArray(schema['required']) ? schema['required'].map(String) : []);
  const names = [...new Set([...Object.keys(properties), ...required])];
  const fields = names.map((name) => ({
    name,
    required: required.has(name),
    type: Object.hasOwn(properties, name)
      ? compileSchema(
          scope,
          properties[name],
          pointerJoin(pointerJoin(pointer, 'properties'), name),
        )
      : UNKNOWN,
  }));
  const extra = schema['additionalProperties'];
  if (extra !== undefined && typeof extra !== 'boolean') {
    if (fields.length > 0) return refuse(pointer, 'properties beside a typed additionalProperties');
    return {
      kind: 'record',
      values: compileSchema(scope, extra, pointerJoin(pointer, 'additionalProperties')),
    };
  }
  if (fields.length === 0 && extra !== false) return { kind: 'record', values: UNKNOWN };
  return { kind: 'object', fields };
}

function typed(
  scope: SchemaScope,
  schema: Readonly<Record<string, unknown>>,
  type: unknown,
  pointer: string,
): ClientType {
  switch (type) {
    case 'string':
      return { kind: 'string' };
    case 'integer':
    case 'number':
      return { kind: 'number', integer: type === 'integer' };
    case 'boolean':
      return { kind: 'boolean' };
    case 'null':
      return NULL;
    case 'array':
      return {
        kind: 'array',
        items:
          schema['items'] === undefined
            ? UNKNOWN
            : compileSchema(scope, schema['items'], pointerJoin(pointer, 'items')),
      };
    case 'object':
      return objectOf(scope, schema, pointer);
    default:
      return refuse(pointerJoin(pointer, 'type'), `the type ${JSON.stringify(type)}`);
  }
}

function literalOf(value: unknown, pointer: string): ClientType {
  if (value === null) return NULL;
  if (typeof value === 'string' || typeof value === 'boolean') return { kind: 'literal', value };
  if (typeof value === 'number' && Number.isFinite(value)) return { kind: 'literal', value };
  return refuse(pointer, 'an enum or const value that is not a string, number, boolean or null');
}

/** What a schema with no combinator says: its `type` (or the type its keywords imply). */
function shapeOf(
  scope: SchemaScope,
  schema: Readonly<Record<string, unknown>>,
  pointer: string,
): ClientType {
  if (Array.isArray(schema['enum'])) {
    return unionOf(schema['enum'].map((value, i) => literalOf(value, pointerJoin(pointer, i))));
  }
  if (Object.hasOwn(schema, 'const'))
    return literalOf(schema['const'], pointerJoin(pointer, 'const'));
  if (Array.isArray(schema['type'])) {
    return unionOf(schema['type'].map((type) => typed(scope, schema, type, pointer)));
  }
  if (schema['type'] !== undefined) return typed(scope, schema, schema['type'], pointer);
  if (schema['properties'] !== undefined || schema['additionalProperties'] !== undefined) {
    return objectOf(scope, schema, pointer);
  }
  if (schema['required'] !== undefined) return objectOf(scope, schema, pointer);
  if (schema['items'] !== undefined) return typed(scope, schema, 'array', pointer);
  return UNKNOWN;
}

const hasShape = (schema: Readonly<Record<string, unknown>>): boolean =>
  ['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'].some((key) =>
    Object.hasOwn(schema, key),
  );

const without = (
  schema: Readonly<Record<string, unknown>>,
  keys: readonly string[],
): Readonly<Record<string, unknown>> =>
  Object.fromEntries(Object.entries(schema).filter(([key]) => !keys.includes(key)));

function combined(
  scope: SchemaScope,
  schema: Readonly<Record<string, unknown>>,
  pointer: string,
): ClientType {
  if (typeof schema['$ref'] === 'string') {
    const target = reachComponent(scope, schema['$ref'], pointerJoin(pointer, '$ref'));
    const rest = without(schema, ['$ref']);
    if (!hasShape(rest) && rest['allOf'] === undefined) return target;
    const merged = mergeObjects([
      asObject(scope, target, pointer),
      asObject(scope, compileSchema(scope, rest, pointer), pointer),
    ]);
    return merged;
  }
  if (Array.isArray(schema['allOf'])) {
    const members = schema['allOf'].map((member, i) =>
      compileSchema(scope, member, pointerJoin(pointerJoin(pointer, 'allOf'), i)),
    );
    const rest = without(schema, ['allOf']);
    const all = hasShape(rest) ? [...members, compileSchema(scope, rest, pointer)] : members;
    if (all.length === 1) return all[0] as ClientType;
    return mergeObjects(all.map((member) => asObject(scope, member, pointer)));
  }
  const key = Array.isArray(schema['oneOf'])
    ? 'oneOf'
    : Array.isArray(schema['anyOf'])
      ? 'anyOf'
      : '';
  if (key !== '') {
    const list = schema[key] as readonly unknown[];
    const members = list.map((member, i) =>
      compileSchema(scope, member, pointerJoin(pointerJoin(pointer, key), i)),
    );
    const rest = without(schema, ['oneOf', 'anyOf']);
    if (!hasShape(rest)) return unionOf(members);
    const base = asObject(scope, shapeOf(scope, rest, pointer), pointer);
    return unionOf(members.map((member) => mergeObjects([base, asObject(scope, member, pointer)])));
  }
  return shapeOf(scope, schema, pointer);
}

/** The one entry point: a schema at `pointer` to its `ClientType`, or a refusal naming where. */
export function compileSchema(scope: SchemaScope, schema: unknown, pointer: string): ClientType {
  if (schema === true) return UNKNOWN;
  const node = objectAt(schema);
  if (node === undefined) return refuse(pointer, 'a schema that is not an object');
  for (const key of Object.keys(node)) {
    if (SHAPE_KEYS.has(key) || NARROWING_KEYS.has(key) || key.startsWith('x-')) continue;
    refuse(pointerJoin(pointer, key), `the keyword ${key}`);
  }
  const type = combined(scope, node, pointer);
  return node['nullable'] === true ? unionOf([type, NULL]) : type;
}
