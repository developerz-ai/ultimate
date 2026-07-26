// A Standard Schema (`t.object({...})`, Zod, Valibot) -> the JSON Schema subset the wire speaks.
//
// Two `JsonSchema` types exist on purpose. `@ultimat3/schema` emits the full draft-07 vocabulary;
// `wire.ts` declares the narrow subset `validate-args.ts` can actually ENFORCE. Handing an agent a
// keyword the server ignores is worse than omitting it — the agent obeys a rule nothing checks and
// gets a silent pass. So this is a real projection, not a cast: a keyword outside the subset is
// dropped here, and `tools/list` publishes only what the resolver will hold a call to.

import type { JsonSchema as RichJsonSchema } from '@ultimat3/schema';
import { toMcpInputSchema } from '@ultimat3/schema';
import type { JsonSchema } from './wire';

/** Introspect any Standard Schema and narrow the result to the wire subset. */
export function toWireSchema(schema: unknown): JsonSchema {
  return narrow(toMcpInputSchema(schema));
}

function narrow(source: RichJsonSchema): JsonSchema {
  // exactOptionalPropertyTypes: every field is attached only when it is present, never as
  // an explicit `undefined` — `tools/list` serialises this object verbatim.
  return {
    ...(source.type === undefined ? {} : { type: source.type }),
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.properties === undefined ? {} : { properties: narrowProperties(source.properties) }),
    ...(source.required === undefined ? {} : { required: source.required }),
    ...narrowAdditional(source.additionalProperties),
    ...(source.items === undefined ? {} : { items: narrow(source.items) }),
    ...(source.enum === undefined ? {} : { enum: source.enum }),
    ...(source.const === undefined ? {} : { const: source.const }),
    ...(source.default === undefined ? {} : { default: source.default }),
    ...(source.format === undefined ? {} : { format: source.format }),
    ...(source.minimum === undefined ? {} : { minimum: source.minimum }),
    ...(source.maximum === undefined ? {} : { maximum: source.maximum }),
    ...(source.minLength === undefined ? {} : { minLength: source.minLength }),
    ...(source.maxLength === undefined ? {} : { maxLength: source.maxLength }),
    ...(source.anyOf === undefined ? {} : { anyOf: source.anyOf.map(narrow) }),
  };
}

function narrowProperties(
  properties: Readonly<Record<string, RichJsonSchema>>,
): Readonly<Record<string, JsonSchema>> {
  const out: Record<string, JsonSchema> = {};
  for (const [key, child] of Object.entries(properties)) out[key] = narrow(child);
  return out;
}

/**
 * A record schema says "extra keys, shaped like this". The wire subset can only say yes or no,
 * and `validate-args.ts` reads `false` as "reject unknown keys" — so an unrepresentable value
 * schema becomes `true` (permit) rather than a rejection the agent was never warned about.
 */
function narrowAdditional(value: boolean | RichJsonSchema | undefined): {
  readonly additionalProperties?: boolean;
} {
  if (value === undefined) return {};
  return { additionalProperties: typeof value === 'boolean' ? value : true };
}
