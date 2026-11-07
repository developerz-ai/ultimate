// A runtime tool's `inputSchema`, read off a row: copied into the wire subset or refused whole.
//
// A static tool's schema is narrowed from a Standard Schema by `@ultimat3/schema`, so what
// `tools/list` publishes is what `validateArgs` enforces. A row's JSON Schema has no such step, and a
// keyword outside the subset (`format`, `oneOf`, `$ref`) would be PUBLISHED and never enforced — so
// it is refused, never dropped: dropping a constraint the author wrote widens the tool silently.

import { renderCauseValue } from '@ultimat3/core';
import { McpCatalogUnresolvedError } from './catalog-errors';
import type { JsonSchema } from './wire';

/** Every keyword `validateArgs` enforces — `WireJsonSchema`'s members, nothing else. */
const KEYWORDS: ReadonlySet<string> = new Set([
  'type',
  'title',
  'description',
  'properties',
  'required',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'enum',
  'const',
  'default',
  'minimum',
  'maximum',
  'minLength',
  'maxLength',
  'pattern',
  'x-ultimate-pattern-flags',
  'anyOf',
]);

const TYPES: ReadonlySet<unknown> = new Set([
  'object',
  'string',
  'number',
  'integer',
  'boolean',
  'array',
  'null',
]);

/** Nesting a row's schema may reach. Deeper is a cycle or a schema no model reads. */
const MAX_DEPTH = 16;

/** `value` as a wire-subset schema whose root is an object, or `X_MCP_CATALOG_UNRESOLVED`. */
export function runtimeInputSchema(tool: string, value: unknown): JsonSchema {
  const schema = node(tool, value, 'inputSchema', 0);
  if (schema.type !== 'object') refuse(tool, 'inputSchema', 'its root must be { type: "object" }');
  return schema;
}

function node(tool: string, value: unknown, at: string, depth: number): JsonSchema {
  if (depth > MAX_DEPTH) refuse(tool, at, `nests deeper than ${MAX_DEPTH}`);
  if (!isRecord(value)) refuse(tool, at, 'is not a JSON Schema object');
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (!KEYWORDS.has(key)) {
      refuse(tool, at, `uses ${renderCauseValue(key)}, outside the subset validateArgs enforces`);
    }
    put(out, key, keyword(tool, key, child, `${at}.${key}`, depth));
  }
  return out as JsonSchema;
}

function keyword(tool: string, key: string, value: unknown, at: string, depth: number): unknown {
  switch (key) {
    case 'type':
      if (!TYPES.has(value)) refuse(tool, at, 'is not a JSON Schema type');
      return value;
    case 'properties': {
      if (!isRecord(value)) refuse(tool, at, 'is not an object');
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(value)) {
        put(out, name, node(tool, child, `${at}.${name}`, depth + 1));
      }
      return out;
    }
    case 'items':
      return node(tool, value, at, depth + 1);
    case 'anyOf':
      if (!Array.isArray(value)) refuse(tool, at, 'is not an array');
      return value.map((child, index) => node(tool, child, `${at}[${index}]`, depth + 1));
    case 'required':
      if (!Array.isArray(value) || !value.every((name) => typeof name === 'string')) {
        refuse(tool, at, 'is not a list of names');
      }
      return [...value];
    case 'enum':
      if (!Array.isArray(value) || !value.every(isScalar)) refuse(tool, at, 'is not scalars');
      return [...value];
    case 'const':
      if (!isScalar(value)) refuse(tool, at, 'is not a scalar');
      return value;
    case 'additionalProperties':
      if (typeof value !== 'boolean') refuse(tool, at, 'is not a boolean');
      return value;
    case 'title':
    case 'description':
    case 'pattern':
    case 'x-ultimate-pattern-flags':
      if (typeof value !== 'string') refuse(tool, at, 'is not a string');
      return value;
    case 'default':
      return value;
    // minItems, maxItems, minimum, maximum, minLength, maxLength — the rest of `KEYWORDS`.
    default:
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        refuse(tool, at, 'is not a finite number');
      }
      return value;
  }
}

/** Through `defineProperty`: a property named `__proto__` is a key, never a re-prototyping. */
function put(out: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(out, key, { value, enumerable: true, writable: true, configurable: true });
}

function refuse(tool: string, at: string, why: string): never {
  throw new McpCatalogUnresolvedError({
    cause: `runtime tool ${renderCauseValue(tool)}: ${at} ${why}`,
  });
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isScalar = (value: unknown): value is string | number | boolean | null =>
  value === null || ['string', 'number', 'boolean'].includes(typeof value);
