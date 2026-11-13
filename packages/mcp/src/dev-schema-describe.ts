// `schema.describe`'s argument and answer: every entity, or the one an agent names. Its own file
// because `dev-server.ts` is at its ceiling, and the narrowing is the only logic the tool has.

import type { McpToolResult } from './registry';
import { jsonResult, textResult } from './registry';
import type { JsonSchema } from './wire';

export const ENTITY_ARG: JsonSchema = {
  type: 'object',
  properties: {
    entity: { type: 'string', description: 'One entity, by name (post) or table (posts).' },
  },
  additionalProperties: false,
};

/**
 * `schema.describe`, whole or for one entity. It took no arguments, so `{ entity: 'post' }` — the
 * call an agent makes first — was refused as X_INPUT_INVALID with a fix naming `x actions show`,
 * a command about actions. An unknown name answers the names there are, never an empty list.
 */
export function describeSchema(entities: unknown, wanted: unknown): McpToolResult {
  if (typeof wanted !== 'string' || !Array.isArray(entities)) return jsonResult(entities);
  // Widened to `unknown`, never left as `Array.isArray`'s `any[]`: the host's answer is unchecked.
  const list: readonly unknown[] = entities;
  const field = (entry: unknown, key: string): unknown =>
    typeof entry === 'object' && entry !== null
      ? (entry as Record<string, unknown>)[key]
      : undefined;
  const found = list.filter(
    (entry) => field(entry, 'name') === wanted || field(entry, 'table') === wanted,
  );
  if (found.length > 0) return jsonResult(found);
  const known = list.map((entry) => field(entry, 'name')).filter((n) => typeof n === 'string');
  return textResult(
    `no entity named ${JSON.stringify(wanted)}; known: ${known.join(', ') || '(none)'} — ` +
      'call schema.describe with one of them, or with no entity for all',
    true,
  );
}
