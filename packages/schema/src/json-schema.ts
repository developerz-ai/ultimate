// Single responsibility: SchemaNode -> JSON Schema. Load-bearing: OpenAPI request/response
// bodies and MCP tool `inputSchema` are both this function's output, so an agent's view of an
// action and an HTTP client's view can never drift.

import { CURRENCY_CODE_PATTERN, MAX_MONEY_SCALE } from './money-value';
import { requiredKeys, type SchemaNode, type SchemaRefinement } from './node';
import { introspect } from './provider';

export type JsonSchemaType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'object'
  | 'array'
  /** Only ever emitted as the second branch of a nullable field's `anyOf` — see `annotate`. */
  | 'null';

/** OpenAPI 3.1's tagged-union hint. `propertyName` alone: the branches here are inline, not `$ref`. */
export interface JsonSchemaDiscriminator {
  readonly propertyName: string;
}

export interface JsonSchema {
  readonly $schema?: string;
  readonly type?: JsonSchemaType;
  readonly format?: string;
  readonly description?: string;
  readonly default?: unknown;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly enum?: readonly (string | number)[];
  readonly const?: string | number | boolean | null;
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
  readonly anyOf?: readonly JsonSchema[];
  readonly discriminator?: JsonSchemaDiscriminator;
  readonly title?: string;
  /**
   * The refinements a consumer can act on mechanically. The prose copy also lands in
   * `description`, because that is the only field an LLM reading an MCP tool schema is
   * guaranteed to see — the extension is for code generators, the description is for readers.
   */
  readonly 'x-ultimate-refinements'?: readonly SchemaRefinement[];
}

export type JsonSchemaDialect = '2020-12' | 'draft-07';

const DIALECTS = Object.freeze<Record<JsonSchemaDialect, string>>({
  '2020-12': 'https://json-schema.org/draft/2020-12/schema',
  'draft-07': 'http://json-schema.org/draft-07/schema#',
});

export interface ToJsonSchemaOptions {
  /** MCP clients are happiest with `draft-07`; OpenAPI 3.1 wants `2020-12` (the default). */
  readonly dialect?: JsonSchemaDialect | undefined;
  /** Emit `$schema` at the root. Off for OpenAPI component schemas. */
  readonly includeDialect?: boolean | undefined;
  readonly title?: string | undefined;
}

const FORMAT_MAP: Readonly<Record<string, string>> = Object.freeze({
  uuid: 'uuid',
  email: 'email',
  uri: 'uri',
  'date-time': 'date-time',
  slug: 'slug',
  timezone: 'iana-time-zone',
  locale: 'bcp47-locale',
  cursor: 'ultimate-cursor',
});

/**
 * `Object.hasOwn`, never the read alone: `node.format` comes from a schema PROVIDER's IR, so
 * `FORMAT_MAP['constructor']` answered with the `Object` function and `?? node.format` could not
 * rescue it — `JSON.stringify` then dropped `format` from the published document in silence.
 * Same discriminator as `@ultimat3/action`'s `BY_FORMAT[node.format]`, one package up.
 */
const publishedFormat = (format: string): string =>
  Object.hasOwn(FORMAT_MAP, format) ? (FORMAT_MAP[format] ?? format) : format;

function stringNode(node: SchemaNode): JsonSchema {
  return {
    type: 'string',
    ...(node.format === undefined ? {} : { format: publishedFormat(node.format) }),
    ...(node.minLength === undefined ? {} : { minLength: node.minLength }),
    ...(node.maxLength === undefined ? {} : { maxLength: node.maxLength }),
    ...(node.pattern === undefined ? {} : { pattern: node.pattern }),
  };
}

/**
 * The range an `integer` node's validator actually enforces — `Number.isSafeInteger`, the rule
 * `validators.ts` applies and `money-value.ts` already published. Spelled `-MAX_SAFE_INTEGER`
 * rather than `MIN_SAFE_INTEGER` (they are the same number) so the two projections of one rule
 * read identically.
 *
 * A caller's own bound is the published one when it is NARROWER, and is clamped when it is not:
 * `t.number.int().max(2 ** 60)` refuses `2 ** 60` at the boundary whatever the node says, so
 * publishing it would be a promise the parser breaks — which is the disagreement this whole
 * function exists to prevent, one layer out.
 */
const SAFE_INTEGER_MIN = -Number.MAX_SAFE_INTEGER;
const SAFE_INTEGER_MAX = Number.MAX_SAFE_INTEGER;

/**
 * A non-integer `t.number` publishes only what the caller declared: it accepts every finite
 * double, so a safe-integer range on it would tell a generated client to refuse `0.5`.
 */
function numberNode(node: SchemaNode): JsonSchema {
  const integer = node.integer === true;
  const minimum = integer
    ? Math.max(node.minimum ?? SAFE_INTEGER_MIN, SAFE_INTEGER_MIN)
    : node.minimum;
  const maximum = integer
    ? Math.min(node.maximum ?? SAFE_INTEGER_MAX, SAFE_INTEGER_MAX)
    : node.maximum;
  return {
    type: integer ? 'integer' : 'number',
    ...(minimum === undefined ? {} : { minimum }),
    ...(maximum === undefined ? {} : { maximum }),
  };
}

/**
 * JSON Schema's `pattern` is an ECMA-262 source with no flag syntax, so a flagged pattern is
 * stated in prose instead of silently narrowed: a consumer applying `pattern` alone would refuse
 * values this schema accepts, and there is nowhere honest to hide that.
 */
function patternNote(node: SchemaNode): string | undefined {
  if (node.pattern === undefined) return undefined;
  const flags = node.patternFlags;
  return flags === undefined || flags === ''
    ? undefined
    : `pattern is applied with RegExp flags "${flags}"`;
}

function convert(node: SchemaNode): JsonSchema {
  const refinements = node.refinements ?? [];
  const notes = [
    node.description,
    patternNote(node),
    ...refinements.map((refinement) => refinement.message),
  ].filter((part): part is string => part !== undefined);
  const described = notes.length === 0 ? undefined : notes.join(' — ');

  const annotations: JsonSchema = {
    ...(described === undefined ? {} : { description: described }),
    ...(node.hasDefault === true ? { default: node.default } : {}),
    ...(refinements.length === 0 ? {} : { 'x-ultimate-refinements': refinements }),
  };

  /**
   * `null` is a VALUE the field holds, so it joins the type union rather than the annotations —
   * `{ anyOf: [<converted>, { type: 'null' }] }`, which is how OpenAPI 3.1 / JSON Schema 2020-12
   * spell it (3.0's `nullable: true` keyword is gone). Dropping it published a contract every
   * surface at once disagreed with: OpenAPI bodies, MCP `inputSchema`, `respondToolFor` and the
   * typed client all forbade a `null` the action's own `output:` validator returns.
   *
   * The annotations stay OUTSIDE the `anyOf` — they describe the field, not one branch of it —
   * and `requiredKeys` is untouched, because nullable is not optional: the key is still sent.
   */
  const annotate = (schema: JsonSchema): JsonSchema =>
    node.nullable === true
      ? { anyOf: [schema, { type: 'null' }], ...annotations }
      : { ...schema, ...annotations };

  switch (node.kind) {
    case 'string':
      return annotate(stringNode(node));
    case 'number':
      return annotate(numberNode(node));
    case 'boolean':
      return annotate({ type: 'boolean' });
    case 'date':
      return annotate({ type: 'string', format: 'date-time' });
    case 'enum':
      return annotate({ type: 'string', enum: node.values ?? [] });
    case 'literal':
      return annotate({ const: node.literal ?? null });
    case 'array':
      return annotate({
        type: 'array',
        items: node.items === undefined ? {} : convert(node.items),
      });
    case 'union':
      return annotate({
        anyOf: (node.anyOf ?? []).map(convert),
        // Only when the union actually dispatches on a key: an untagged `t.union` carrying a
        // `discriminator` would tell a generator to read a property no member declares.
        ...(node.discriminant === undefined
          ? {}
          : { discriminator: { propertyName: node.discriminant } }),
      });
    case 'record':
      return annotate({
        type: 'object',
        additionalProperties: node.valueNode === undefined ? true : convert(node.valueNode),
      });
    case 'money':
      return annotate({
        type: 'object',
        properties: {
          minor: {
            type: 'integer',
            description: 'amount in minor units, never a float',
            // The safe-integer range the validator enforces, so a generated client refuses the
            // same value the boundary does instead of learning about it from a 500.
            minimum: -Number.MAX_SAFE_INTEGER,
            maximum: Number.MAX_SAFE_INTEGER,
          },
          // The pattern the validator applies, not a copy of it: this object IS the contract a
          // generated client checks against, so a widened predicate here would be a client
          // refusing a code the boundary accepts.
          currency: { type: 'string', pattern: CURRENCY_CODE_PATTERN },
          // Optional, never required: `additionalProperties: false` alone would make a generated
          // client refuse a scaled amount the framework's own validator accepts.
          scale: {
            type: 'integer',
            description: 'decimal places `minor` counts; absent means the currency’s own',
            minimum: 0,
            maximum: MAX_MONEY_SCALE,
          },
        },
        required: ['minor', 'currency'],
        additionalProperties: false,
      });
    case 'object': {
      const properties: Record<string, JsonSchema> = {};
      for (const [key, child] of Object.entries(node.properties ?? {})) {
        properties[key] = convert(child);
      }
      return annotate({
        type: 'object',
        properties,
        required: requiredKeys(node),
        additionalProperties: false,
      });
    }
    default:
      return annotate({});
  }
}

/** Convert any schema the active provider can introspect. */
export function toJsonSchema(schema: unknown, options?: ToJsonSchemaOptions): JsonSchema {
  const converted = convert(introspect(schema));
  const dialect = options?.dialect ?? '2020-12';
  return {
    ...(options?.includeDialect === false ? {} : { $schema: DIALECTS[dialect] }),
    ...(options?.title === undefined ? {} : { title: options.title }),
    ...converted,
  };
}

/** The exact shape an MCP `tools/list` entry needs: draft-07, no `$schema`. */
export function toMcpInputSchema(schema: unknown): JsonSchema {
  return toJsonSchema(schema, { dialect: 'draft-07', includeDialect: false });
}

/** Convert an already-introspected node — used by generators that walk the IR themselves. */
export function nodeToJsonSchema(node: SchemaNode): JsonSchema {
  return convert(node);
}
