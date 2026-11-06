// A remote tool's locked JSON Schema → a `t` schema, so the action wrapping it parses what the model
// sends before anything leaves this process. The common subset is translated (object, string,
// number, integer, boolean, array, string enum, `description`); anything else becomes `t.json()`,
// which the REMOTE server still validates — never wider than the remote, only less precise.

import { isJsonObject } from '@ultimat3/core';
import type { AnySchema } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';

const MAX_DEPTH = 8;

export function schemaFromJson(raw: unknown, depth = 0): AnySchema {
  if (!isJsonObject(raw) || depth > MAX_DEPTH) return t.json();
  const described = (schema: AnySchema): AnySchema =>
    typeof raw['description'] === 'string' ? schema.describe(raw['description']) : schema;
  const values = raw['enum'];
  if (Array.isArray(values) && values.length > 0 && values.every((v) => typeof v === 'string')) {
    return described(t.enum(values as [string, ...string[]]));
  }
  switch (raw['type']) {
    case 'string':
      return described(t.string);
    case 'number':
      return described(t.number);
    case 'integer':
      return described(t.number.int());
    case 'boolean':
      return described(t.boolean);
    case 'array':
      return described(t.array(schemaFromJson(raw['items'], depth + 1)));
    case 'object':
      return described(objectFromJson(raw, depth));
    default:
      return described(t.json());
  }
}

function objectFromJson(raw: Record<string, unknown>, depth: number): AnySchema {
  const properties = isJsonObject(raw['properties']) ? raw['properties'] : undefined;
  // An object with no declared properties is a free-form map: the remote decides what it takes.
  if (properties === undefined) return t.record(t.json());
  const required = new Set(
    Array.isArray(raw['required']) ? raw['required'].filter((k) => typeof k === 'string') : [],
  );
  const shape = new Map<string, AnySchema>();
  for (const [key, value] of Object.entries(properties)) {
    const field = schemaFromJson(value, depth + 1);
    shape.set(key, required.has(key) ? field : field.optional());
  }
  return t.object(Object.fromEntries(shape));
}
