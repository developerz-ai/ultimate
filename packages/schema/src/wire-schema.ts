// Single responsibility: the JSON Schema subset an MCP tool publishes, and the two narrowings onto
// it — an input's and an output's. One home, tier 0, so `@ultimat3/action`'s `.tool()` and
// `@ultimat3/mcp`'s `tools/list` publish ONE document for one declaration rather than two.

import type { JsonSchema } from './json-schema';
import { toMcpInputSchema } from './json-schema';

/**
 * The subset a tool's `inputSchema` and `outputSchema` speak, and the one `@ultimat3/mcp`'s
 * `validateArgs` holds a hand-written tool to. Narrow on purpose: a tool schema an agent cannot
 * fully understand is a tool it will call wrong.
 */
export interface WireJsonSchema {
  readonly type?: 'object' | 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'null';
  readonly title?: string;
  readonly description?: string;
  readonly properties?: Readonly<Record<string, WireJsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: WireJsonSchema;
  readonly enum?: readonly (string | number | boolean | null)[];
  readonly const?: string | number | boolean | null;
  readonly default?: unknown;
  /**
   * NOT in the subset: `format` NAMES a rule whose meaning lives in this package (`uuid`, `email`,
   * `iana-time-zone`), and `validateArgs` cannot hold a hand-written tool to it without a second
   * definition of each one. `never`, so a narrowing that starts copying it again fails to compile.
   * `pattern` is the opposite case — the rule travels WITH the schema, so it is kept.
   */
  readonly format?: never;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minLength?: number;
  readonly maxLength?: number;
  /** A `RegExp.source`, JSON Schema semantics (a partial match unless it anchors itself). */
  readonly pattern?: string;
  /** The flags `pattern` compiles with — JSON Schema's `pattern` carries none. */
  readonly 'x-ultimate-pattern-flags'?: string;
  readonly anyOf?: readonly WireJsonSchema[];
}

/** A Standard Schema → a tool's `inputSchema`. Throws `X_SCHEMA_UNSUPPORTED` when it cannot say. */
export function toWireSchema(schema: unknown): WireJsonSchema {
  return narrow(toMcpInputSchema(schema));
}

/**
 * A Standard Schema → a tool's `outputSchema`, or `undefined` when its root is not an object (MCP's
 * `structuredContent` is one) or it cannot be introspected. STRUCTURE ONLY: a client refuses a call
 * whose `structuredContent` misses this document, and a bound, a pattern or `additionalProperties:
 * false` on a value the server produced (a query's rows are never re-parsed) is a promise nothing
 * enforces on the way out.
 */
export function toWireOutputSchema(schema: unknown): WireJsonSchema | undefined {
  let rich: JsonSchema;
  try {
    rich = toMcpInputSchema(schema);
  } catch {
    return undefined;
  }
  return rich.type === 'object' ? shape(rich) : undefined;
}

// exactOptionalPropertyTypes: every field is attached only when present, never as an explicit
// `undefined` — `tools/list` serialises this object verbatim.
function narrow(source: JsonSchema): WireJsonSchema {
  return {
    ...(source.type === undefined ? {} : { type: source.type }),
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.properties === undefined ? {} : { properties: mapKeys(source.properties, narrow) }),
    ...(source.required === undefined ? {} : { required: source.required }),
    // The subset says yes or no to extra keys; an unrepresentable value schema becomes `true`
    // (permit) rather than a rejection the agent was never warned about.
    ...(source.additionalProperties === undefined
      ? {}
      : { additionalProperties: source.additionalProperties !== false }),
    ...(source.items === undefined ? {} : { items: narrow(source.items) }),
    ...(source.enum === undefined ? {} : { enum: source.enum }),
    ...(source.const === undefined ? {} : { const: source.const }),
    ...(source.default === undefined ? {} : { default: source.default }),
    ...(source.minimum === undefined ? {} : { minimum: source.minimum }),
    ...(source.maximum === undefined ? {} : { maximum: source.maximum }),
    ...(source.minLength === undefined ? {} : { minLength: source.minLength }),
    ...(source.maxLength === undefined ? {} : { maxLength: source.maxLength }),
    ...(source.pattern === undefined ? {} : { pattern: source.pattern }),
    ...(source['x-ultimate-pattern-flags'] === undefined
      ? {}
      : { 'x-ultimate-pattern-flags': source['x-ultimate-pattern-flags'] }),
    ...(source.anyOf === undefined ? {} : { anyOf: source.anyOf.map(narrow) }),
  };
}

function shape(source: JsonSchema): WireJsonSchema {
  return {
    ...(source.type === undefined ? {} : { type: source.type }),
    ...(source.title === undefined ? {} : { title: source.title }),
    ...(source.description === undefined ? {} : { description: source.description }),
    ...(source.properties === undefined ? {} : { properties: mapKeys(source.properties, shape) }),
    ...(source.required === undefined ? {} : { required: source.required }),
    ...(source.items === undefined ? {} : { items: shape(source.items) }),
    ...(source.enum === undefined ? {} : { enum: source.enum }),
    ...(source.const === undefined ? {} : { const: source.const }),
    ...(source.anyOf === undefined ? {} : { anyOf: source.anyOf.map(shape) }),
  };
}

/**
 * `out[key] = …` is not an assignment for exactly one name: `__proto__` runs `Object.prototype`'s
 * setter and RE-PROTOTYPES the record, so a declared field vanishes from `tools/list`.
 */
function mapKeys(
  properties: Readonly<Record<string, JsonSchema>>,
  each: (child: JsonSchema) => WireJsonSchema,
): Readonly<Record<string, WireJsonSchema>> {
  const out: Record<string, WireJsonSchema> = {};
  for (const [key, child] of Object.entries(properties)) {
    Object.defineProperty(out, key, {
      value: each(child),
      writable: true,
      enumerable: true,
      configurable: true,
    });
  }
  return out;
}
