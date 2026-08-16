// Single responsibility: SchemaNode -> JSON Schema. Load-bearing: OpenAPI request/response
// bodies and MCP tool `inputSchema` are both this function's output, so an agent's view of an
// action and an HTTP client's view can never drift.

import { MAX_MONEY_SCALE } from './money-value';
import { requiredKeys, type SchemaNode, type SchemaRefinement } from './node';
import { introspect } from './provider';

export type JsonSchemaType = 'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array';

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

const DIALECTS: Readonly<Record<JsonSchemaDialect, string>> = Object.freeze({
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

function stringNode(node: SchemaNode): JsonSchema {
  return {
    type: 'string',
    ...(node.format === undefined ? {} : { format: FORMAT_MAP[node.format] ?? node.format }),
    ...(node.minLength === undefined ? {} : { minLength: node.minLength }),
    ...(node.maxLength === undefined ? {} : { maxLength: node.maxLength }),
    ...(node.pattern === undefined ? {} : { pattern: node.pattern }),
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

  const annotate = (schema: JsonSchema): JsonSchema => ({
    ...schema,
    ...(described === undefined ? {} : { description: described }),
    ...(node.hasDefault === true ? { default: node.default } : {}),
    ...(refinements.length === 0 ? {} : { 'x-ultimate-refinements': refinements }),
  });

  switch (node.kind) {
    case 'string':
      return annotate(stringNode(node));
    case 'number':
      return annotate({
        type: node.integer === true ? 'integer' : 'number',
        ...(node.minimum === undefined ? {} : { minimum: node.minimum }),
        ...(node.maximum === undefined ? {} : { maximum: node.maximum }),
      });
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
          currency: { type: 'string', pattern: '^[A-Z]{3}$' },
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
