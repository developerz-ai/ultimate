// Single responsibility: a form body's fields coerced toward a schema. A form is text on the wire,
// as a query string is, so its fields take the query's coercion (`coerceQuery`): `ok=true` reaches
// `t.boolean` as `true`, a repeated scalar keeps its last value, one item fills a list. A multipart
// file is not text and passes through as sent.

import { coerceQuery } from '@ultimat3/schema';

const isText = (value: unknown): value is string | readonly string[] =>
  typeof value === 'string' ||
  (Array.isArray(value) && value.every((item: unknown) => typeof item === 'string'));

/** The parsed form `fields`, its text coerced toward `schema`; anything else returned as is. */
export const coerceFormFields = (schema: unknown, fields: unknown): unknown => {
  if (typeof fields !== 'object' || fields === null || Array.isArray(fields)) return fields;
  // Null prototypes for `collectFields`' reason (`request.ts`): the keys are the caller's.
  const text: Record<string, string | readonly string[]> = Object.create(null);
  for (const [key, value] of Object.entries(fields)) if (isText(value)) text[key] = value;
  return Object.assign(Object.create(null), fields, coerceQuery(schema, text));
};
