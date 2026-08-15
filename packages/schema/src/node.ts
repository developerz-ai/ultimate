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
   * JSON Schema's `pattern` has no flags, so `json-schema.ts` states them in `description`.
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
  readonly valueNode?: SchemaNode | undefined;
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
