// An OpenAPI 3.0/3.1 document to the neutral operation list both client emitters read — the ONLY
// reader of OpenAPI in the client path. Operations are compiled first and components only as an
// operation reaches them, so `--only` around a construct the compiler refuses really leaves it out.

import type {
  ClientBody,
  ClientMethod,
  ClientOperation,
  ClientParameter,
  ClientType,
  CompiledDocument,
} from './openapi-compile-ir';
import type { SchemaScope } from './openapi-compile-schema';
import { compileSchema, typeName } from './openapi-compile-schema';
import { ClientSpecInvalidError, objectAt, own, pointerJoin, unsupported } from './openapi-refuse';

type Json = Readonly<Record<string, unknown>>;

const METHODS: ReadonlyMap<string, ClientMethod> = new Map([
  ['get', 'GET'],
  ['put', 'PUT'],
  ['post', 'POST'],
  ['delete', 'DELETE'],
  ['options', 'OPTIONS'],
  ['head', 'HEAD'],
  ['patch', 'PATCH'],
]);
const PATH_ITEM_KEYS = new Set(['summary', 'description', 'servers', 'parameters']);
const JSON_MEDIA = /^application\/(?:[\w.-]+\+)?json$/;

export interface CompileOptions {
  /** Where the document came from, for a refusal's cause. */
  readonly source: string;
  /** Keep only operations carrying one of these tags. */
  readonly only?: readonly string[] | undefined;
}

/** `invoices.get` → `invoicesGet`: a TypeScript identifier, first letter lower. */
export function operationName(id: string): string {
  const pascal = typeName(id);
  return /^T[0-9]/.test(pascal) ? pascal : `${pascal[0]?.toLowerCase() ?? ''}${pascal.slice(1)}`;
}

/** No `operationId`: method then path, `{id}` read as `ById` — still a pure function of the doc. */
const derivedName = (method: string, path: string): string =>
  operationName(
    [method, ...path.split('/').map((s) => s.replace(/^\{(.+)\}$/, 'by-$1'))].join('-'),
  );

/** A `$ref` into `#/components/<section>/` followed once; anything else is the value itself. */
function deref(document: Json, value: unknown, pointer: string): { node: Json; at: string } {
  const node = objectAt(value);
  if (node === undefined) throw unsupported(pointer, 'a value that is not an object');
  if (typeof node['$ref'] !== 'string') return { node, at: pointer };
  const segments = node['$ref'].startsWith('#/components/') ? node['$ref'].slice(2).split('/') : [];
  let target: unknown = document;
  for (const raw of segments) {
    const record = objectAt(target);
    target =
      record === undefined ? undefined : own(record, raw.replace(/~1/g, '/').replace(/~0/g, '~'));
  }
  const resolved = objectAt(target);
  if (segments.length !== 3 || resolved === undefined) {
    throw unsupported(pointerJoin(pointer, '$ref'), `the $ref ${node['$ref']}`);
  }
  return { node: resolved, at: node['$ref'] };
}

/** The JSON media entry of a `content` map; `undefined` when there is none at all. */
function jsonSchemaOf(
  content: unknown,
  pointer: string,
): { schema: unknown; at: string } | undefined {
  const media = objectAt(content);
  if (media === undefined || Object.keys(media).length === 0) return undefined;
  const key = Object.keys(media).find((type) => JSON_MEDIA.test(type));
  if (key === undefined) {
    throw unsupported(pointer, `a body that is not JSON (${Object.keys(media).join(', ')})`);
  }
  const entry = objectAt(media[key]) ?? {};
  return { schema: entry['schema'] ?? true, at: pointerJoin(pointerJoin(pointer, key), 'schema') };
}

function parameterOf(
  document: Json,
  scope: SchemaScope,
  raw: unknown,
  pointer: string,
): ClientParameter {
  const { node, at } = deref(document, raw, pointer);
  const where = node['in'];
  if (where !== 'path' && where !== 'query' && where !== 'header') {
    throw unsupported(pointerJoin(at, 'in'), `a parameter in ${String(where)}`);
  }
  if (node['schema'] === undefined)
    throw unsupported(at, 'a parameter with content instead of schema');
  const type = compileSchema(scope, node['schema'], pointerJoin(at, 'schema'));
  if (where === 'query' && (type.kind === 'object' || type.kind === 'record')) {
    throw unsupported(pointerJoin(at, 'schema'), 'an object-valued query parameter');
  }
  return {
    name: String(node['name']),
    in: where,
    required: node['required'] === true || where === 'path',
    type,
  };
}

const isObjectBody = (scope: SchemaScope, type: ClientType): boolean => {
  if (type.kind === 'object') return true;
  const target = type.kind === 'ref' ? scope.compiled.get(type.name) : undefined;
  return target !== undefined && target !== null && target.kind === 'object';
};

function bodyOf(
  document: Json,
  scope: SchemaScope,
  raw: unknown,
  pointer: string,
): ClientBody | undefined {
  if (raw === undefined) return undefined;
  const { node, at } = deref(document, raw, pointer);
  const found = jsonSchemaOf(node['content'], pointerJoin(at, 'content'));
  if (found === undefined) return undefined;
  const type = compileSchema(scope, found.schema, found.at);
  const required = node['required'] === true;
  return isObjectBody(scope, type)
    ? { mode: 'fields', type, required }
    : { mode: 'value', type, required };
}

function responseOf(
  document: Json,
  scope: SchemaScope,
  responses: Json,
  pointer: string,
): ClientType | undefined {
  const success = Object.keys(responses)
    .filter((status) => /^2(?:\d\d|XX)$/.test(status))
    .sort()[0];
  if (success === undefined) return undefined;
  const { node, at } = deref(document, responses[success], pointerJoin(pointer, success));
  const found = jsonSchemaOf(node['content'], pointerJoin(at, 'content'));
  return found === undefined ? undefined : compileSchema(scope, found.schema, found.at);
}

function refusalsOf(responses: Json): readonly string[] {
  const codes = new Set<string>();
  for (const [status, value] of Object.entries(responses)) {
    const declared = /^2/.test(status) ? undefined : objectAt(value)?.['x-ultimate-errors'];
    if (Array.isArray(declared)) for (const code of declared) codes.add(String(code));
  }
  return [...codes].sort();
}

function operationOf(
  document: Json,
  scope: SchemaScope,
  input: {
    path: string;
    method: string;
    op: Json;
    shared: readonly unknown[];
    itemPointer: string;
    pointer: string;
  },
): ClientOperation {
  const { op, pointer } = input;
  const byKey = new Map<string, ClientParameter>();
  // Path-item parameters first, so an operation's own parameter of the same name and place wins.
  const lists: readonly (readonly [readonly unknown[], string])[] = [
    [input.shared, pointerJoin(input.itemPointer, 'parameters')],
    [Array.isArray(op['parameters']) ? op['parameters'] : [], pointerJoin(pointer, 'parameters')],
  ];
  for (const [list, at] of lists) {
    list.forEach((raw, i) => {
      const parameter = parameterOf(document, scope, raw, pointerJoin(at, i));
      byKey.set(`${parameter.in}:${parameter.name}`, parameter);
    });
  }
  const parameters = [...byKey.values()];
  const body = bodyOf(document, scope, op['requestBody'], pointerJoin(pointer, 'requestBody'));
  if (body?.mode === 'value' && parameters.some((p) => p.name === 'body')) {
    throw unsupported(
      pointerJoin(pointer, 'parameters'),
      'a parameter named body beside a non-object body',
    );
  }
  const responses = objectAt(op['responses']) ?? {};
  return {
    name:
      typeof op['operationId'] === 'string'
        ? operationName(op['operationId'])
        : derivedName(input.method, input.path),
    method: METHODS.get(input.method) as ClientMethod,
    path: input.path,
    tags: Array.isArray(op['tags']) ? op['tags'].map(String) : [],
    summary: typeof op['summary'] === 'string' ? op['summary'] : undefined,
    parameters,
    body,
    response: responseOf(document, scope, responses, pointerJoin(pointer, 'responses')),
    refusals: refusalsOf(responses),
  };
}

function checkedDocument(document: unknown, source: string): Json {
  const root = objectAt(document);
  if (root === undefined)
    throw new ClientSpecInvalidError({ source, reason: 'it is not a JSON object' });
  const version = root['openapi'];
  if (typeof version !== 'string' || !/^3\.[01]\.\d+/.test(version)) {
    throw new ClientSpecInvalidError({ source, reason: 'its openapi field is not 3.0.x or 3.1.x' });
  }
  if (objectAt(root['paths']) === undefined) {
    throw new ClientSpecInvalidError({ source, reason: 'it has no paths object' });
  }
  return root;
}

/** The whole document, in a deterministic order: operations by name, types by component name. */
export function compileOpenApi(document: unknown, options: CompileOptions): CompiledDocument {
  const root = checkedDocument(document, options.source);
  const scope: SchemaScope = {
    components: objectAt(objectAt(root['components'])?.['schemas']) ?? {},
    compiled: new Map(),
  };
  const only = options.only === undefined ? undefined : new Set(options.only);
  const operations: ClientOperation[] = [];
  const paths = objectAt(root['paths']) ?? {};
  for (const path of Object.keys(paths).sort()) {
    const itemPointer = pointerJoin('#/paths', path);
    const item = objectAt(paths[path]) ?? {};
    const shared = Array.isArray(item['parameters']) ? item['parameters'] : [];
    for (const [key, value] of Object.entries(item)) {
      if (PATH_ITEM_KEYS.has(key) || key.startsWith('x-')) continue;
      if (!METHODS.has(key))
        throw unsupported(pointerJoin(itemPointer, key), `the path item key ${key}`);
      const op = objectAt(value) ?? {};
      const tags = Array.isArray(op['tags']) ? op['tags'].map(String) : [];
      if (only !== undefined && !tags.some((tag) => only.has(tag))) continue;
      const pointer = pointerJoin(itemPointer, key);
      const compiled = operationOf(root, scope, {
        path,
        method: key,
        op,
        shared,
        itemPointer,
        pointer,
      });
      if (operations.some((other) => other.name === compiled.name)) {
        throw unsupported(pointer, `a second operation named ${compiled.name}`);
      }
      operations.push(compiled);
    }
  }
  const types = new Map<string, ClientType>();
  const spelled = new Map<string, string>();
  for (const name of [...scope.compiled.keys()].sort()) {
    const clash = spelled.get(typeName(name));
    if (clash !== undefined) {
      throw unsupported(`#/components/schemas/${name}`, `a component spelled like ${clash}`);
    }
    spelled.set(typeName(name), name);
    types.set(name, scope.compiled.get(name) as ClientType);
  }
  const info = objectAt(root['info']) ?? {};
  return {
    title: typeof info['title'] === 'string' ? info['title'] : options.source,
    version: typeof info['version'] === 'string' ? info['version'] : '0.0.0',
    types,
    operations: operations.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)),
  };
}
