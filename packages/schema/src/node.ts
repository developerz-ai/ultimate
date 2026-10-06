// Single responsibility: the introspectable schema IR. Flat on purpose — OpenAPI generation,
// MCP tool schemas, HTTP query coercion and the admin form generator all read this one shape,
// so it must stay trivially walkable.

export type SchemaKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'date'
  | 'object'
  | 'array'
  | 'enum'
  | 'literal'
  | 'union'
  | 'record'
  | 'money'
  /**
   * Any JSON value — `t.json()`. A kind and not a field on `unknown`, because they are different
   * facts: `unknown` is the IR saying it CANNOT describe a value (`@ultimat3/entity`'s view of a
   * column it has no node for), `json` is the IR saying exactly what it holds. Every foreign
   * `default:` already degrades to the right projection — `{}`, a raw pass-through, a `null`
   * sample, admin's JSON textarea — so a consumer that has never heard of it is still correct.
   */
  | 'json'
  | 'unknown';

/** JSON Schema `format`, plus the framework's own semantic formats. */
export type SchemaFormat =
  | 'uuid'
  | 'email'
  | 'uri'
  | 'date-time'
  | 'slug'
  | 'timezone'
  | 'locale'
  | 'cursor';

/**
 * A refinement as the IR carries it: the predicate's *declaration*, never the predicate. A closure
 * cannot cross into OpenAPI or an MCP tool schema, so what ships is the name and the rule text —
 * enough for a generated client to state the constraint and for a form to label the failure.
 */
export interface SchemaRefinement {
  readonly name: string;
  readonly message: string;
  readonly path?: readonly string[] | undefined;
}

export interface SchemaNode {
  readonly kind: SchemaKind;
  readonly optional?: boolean | undefined;
  /** Separate from `optional`: JSON Schema and the DB both distinguish null from absent. */
  readonly nullable?: boolean | undefined;
  readonly hasDefault?: boolean | undefined;
  readonly default?: unknown;
  readonly description?: string | undefined;
  readonly format?: SchemaFormat | undefined;
  readonly minLength?: number | undefined;
  readonly maxLength?: number | undefined;
  /** Source string of the RegExp, so the node stays JSON-serialisable. */
  readonly pattern?: string | undefined;
  /**
   * The RegExp's flags, carried beside the source for the same reason. Dropping them made
   * `t.string.pattern(/^[a-z]+$/i)` reject `ABC` while quoting the pattern that matches it.
   * JSON Schema's `pattern` has no flags, so `json-schema.ts` publishes them as
   * `x-ultimate-pattern-flags` beside it, and states them in `description` for a reader.
   */
  readonly patternFlags?: string | undefined;
  readonly minimum?: number | undefined;
  readonly maximum?: number | undefined;
  readonly integer?: boolean | undefined;
  readonly properties?: Readonly<Record<string, SchemaNode>> | undefined;
  readonly items?: SchemaNode | undefined;
  readonly values?: readonly (string | number)[] | undefined;
  readonly literal?: string | number | boolean | null | undefined;
  readonly anyOf?: readonly SchemaNode[] | undefined;
  /**
   * The key a `union` dispatches on. Additive rather than a `'discriminatedUnion'` kind: every
   * consumer that switches on `kind` — `json-schema.ts`, `coerce.ts`, `action`'s sample generator,
   * the admin form generator — already handles `'union'` correctly, and a new kind would have
   * fallen through each of their `default:` branches to an empty schema without failing anything.
   */
  readonly discriminant?: string | undefined;
  readonly valueNode?: SchemaNode | undefined;
  /**
   * Rules the structural fields cannot state. Carried beside `kind` rather than wrapping it for
   * the reason `discriminant` is: a refined string must still read as a string everywhere.
   */
  readonly refinements?: readonly SchemaRefinement[] | undefined;
}

export function isSchemaNode(value: unknown): value is SchemaNode {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { kind?: unknown }).kind === 'string'
  );
}

/** Duck-typed: any object carrying a `node` is introspectable, whatever built it. */
export function nodeOf(value: unknown): SchemaNode | undefined {
  if (typeof value !== 'object' || value === null || !('node' in value)) return undefined;
  const node = (value as { node: unknown }).node;
  return isSchemaNode(node) ? node : undefined;
}

/** Keys an object node requires — everything not optional and without a default. */
export function requiredKeys(node: SchemaNode): readonly string[] {
  if (node.properties === undefined) return [];
  return Object.entries(node.properties)
    .filter(([, child]) => child.optional !== true && child.hasDefault !== true)
    .map(([key]) => key);
}
