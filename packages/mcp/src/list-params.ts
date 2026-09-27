// `listParams` — composition pushed into params, not tools: one list query answers filters,
// `sort`, `fields` and a keyset `cursor` + `limit` over a WHITELIST it declares, instead of an app
// shipping `listRecentX`, `listPaidX`, `xByOrg`. This file turns the declaration into the schema
// `describe_resource` publishes and `manage_resource` enforces before the query's own parse.
//
// FLAT keys (`status_eq`, not `filters: { status: { eq } }`): a query's input is projected to a
// query string (`@ultimat3/query` refuses a nested object in `input-shape.ts`), so the one shape
// every surface can carry is the one this whitelist publishes.

import { finiteCount } from '@ultimat3/core';
import { McpListParamsInvalidError } from './meta-errors';
import type { JsonSchema } from './wire';

/** The five comparison operators. A filter key is `<field><op>`: `status_eq`, `amount_gt`. */
export type ListFilterOp = '_eq' | '_in' | '_gt' | '_lt' | '_cont';

/** The largest page `limit` may ask for when a query declares no `maxLimit`. */
export const DEFAULT_LIST_MAX_LIMIT = 100;

/**
 * What a list query composes over. Every member is a whitelist: a filter field with the operators
 * it takes, the sortable fields, the fields a sparse response may pick.
 *
 * The query's own `input` declares the same keys — `status_eq`, `sort`, `fields`, `cursor`,
 * `limit` — and implements them; the dispatcher refuses anything outside the whitelist before the
 * query runs, and a whitelisted key the input does not declare is refused at BOOT
 * (`X_MCP_LIST_PARAMS_INVALID`), because the query would silently never read it. `cursor` is
 * opaque and keyset, never an offset.
 */
export interface McpListParams {
  readonly filters?: Readonly<Record<string, readonly ListFilterOp[]>>;
  readonly sort?: readonly string[];
  readonly fields?: readonly string[];
  /** Ceiling for `limit`. Defaults to `DEFAULT_LIST_MAX_LIMIT`. */
  readonly maxLimit?: number;
}

const SCALAR: JsonSchema = {
  anyOf: [{ type: 'string' }, { type: 'number' }, { type: 'boolean' }],
};

const ORDERED: JsonSchema = { anyOf: [{ type: 'string' }, { type: 'number' }] };

function operandSchema(op: ListFilterOp): JsonSchema {
  switch (op) {
    case '_in':
      return { type: 'array', items: SCALAR };
    case '_cont':
      return { type: 'string', minLength: 1 };
    case '_gt':
    case '_lt':
      return ORDERED;
    case '_eq':
      return SCALAR;
  }
}

/** The whitelisted keys and their wire schemas, in declaration order. */
export function listParamsProperties(spec: McpListParams): readonly [string, JsonSchema][] {
  const out: [string, JsonSchema][] = [];
  for (const [field, ops] of Object.entries(spec.filters ?? {})) {
    for (const op of new Set(ops)) out.push([`${field}${op}`, operandSchema(op)]);
  }
  if (spec.sort !== undefined && spec.sort.length > 0) {
    out.push([
      'sort',
      {
        type: 'string',
        description: 'a field, ascending; prefix "-" for descending',
        enum: spec.sort.flatMap((field) => [field, `-${field}`]),
      },
    ]);
  }
  if (spec.fields !== undefined && spec.fields.length > 0) {
    out.push(['fields', { type: 'array', items: { type: 'string', enum: spec.fields } }]);
  }
  out.push([
    'cursor',
    { type: 'string', maxLength: 1024, description: 'opaque keyset cursor from the last page' },
  ]);
  // Refused rather than published: `maximum: NaN` is a ceiling `validateArgs` never trips.
  const maxLimit = finiteCount(
    'listParams',
    'maxLimit',
    spec.maxLimit ?? DEFAULT_LIST_MAX_LIMIT,
    1,
  );
  out.push(['limit', { type: 'integer', minimum: 1, maximum: maxLimit }]);
  return out;
}

/**
 * The schema `manage_resource` validates a list call against: the tool's own input with every
 * list key NARROWED to the whitelist, and nothing else admitted. `Object.fromEntries` (a define,
 * never `[k] =`) because a field name is the app's string and `__proto__` must land as a key.
 */
export function listParamsSchema(spec: McpListParams, base: JsonSchema): JsonSchema {
  const properties = Object.fromEntries([
    ...Object.entries(base.properties ?? {}),
    ...listParamsProperties(spec),
  ]);
  return {
    type: 'object',
    properties,
    ...(base.required === undefined ? {} : { required: base.required }),
    additionalProperties: false,
  };
}

/**
 * Boot-time: every whitelisted key must be one the tool's input declares. A key the input does not
 * declare is either refused by the query's parse or stripped by it — the second is a filter an
 * agent was promised and the query never applied, which is worse than no filter at all.
 */
export function assertListParams(name: string, spec: McpListParams, base: JsonSchema): void {
  const declared = base.properties ?? {};
  for (const [key] of listParamsProperties(spec)) {
    if (!Object.hasOwn(declared, key)) throw new McpListParamsInvalidError({ name, key });
  }
}
