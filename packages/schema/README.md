# ✅ @ultimat3/schema

Tier 0. The validation seam. One schema declaration projects to a runtime validator, a TypeScript
type, a JSON Schema, an OpenAPI body, an MCP tool `inputSchema` and HTTP query coercion.

| Owns | Module |
|---|---|
| Standard Schema v1 types + `validate()` / `parse()` for **any** conforming library | `standard.ts` |
| the blessed `t` namespace | `t.ts` |
| builtin validators behind `t` | `validators.ts` |
| the introspectable IR every generator walks | `node.ts` |
| `Schema` factory, `Infer` machinery | `builder.ts` |
| `configureSchemaProvider()` — the swap point | `provider.ts` |
| schema → JSON Schema (OpenAPI + MCP) | `json-schema.ts` |
| HTTP-boundary coercion, kept out of validation | `coerce.ts` |
| `X_VALIDATION_FAILED` with path-annotated issues | `errors.ts` |

## `t`

```ts
import { t, type Infer } from '@ultimat3/schema';

export const publishPost = t.object({
  postId:   t.uuid,
  notify:   t.boolean.default(true),
  title:    t.string.min(3).max(80),
  tags:     t.array(t.slug),
  price:    t.money,                 // { minor: 1999, currency: 'EUR' } — never a float
  timeZone: t.timezone,              // real IANA validation, not an annotation
  cursor:   t.optional(t.cursor),
});

type PublishPost = Infer<typeof publishPost>;
```

| Value schemas | Factories | Methods |
|---|---|---|
| `string` `number` `boolean` `date` `uuid` `email` `url` | `object` `array` `enum` `literal` `union` `record` `optional` `nullable` | `.default(v)` `.optional()` `.nullable()` `.describe(s)` |
| `money` `timezone` `locale` `slug` `cursor` | `object(...).extend/.pick/.omit` | `string.min/.max/.pattern`, `number.min/.max/.int` |

`nullable` is a value the row holds; `optional` is the caller omitting the key. Both ship as a
namespace member (`t.nullable`) and a free function (`nullableSchema`) — symmetrically.

Unknown object keys are **dropped**, never forwarded — an action cannot be mass-assigned.

**You rarely import this package.** `action`, `query`, `jobs` and `entity` each re-export the same
`t`, so an authoring file imports its primitive and nothing else. Import `@ultimat3/schema` directly
only where there is no primitive to hang the schema off — app config, a standalone view schema, a
provider swap.

## Errors tell an agent exactly what to send

```ts
parse(t.object({ postId: t.uuid, notify: t.boolean }), { postId: 'abc', notify: 'yes' }, 'input');
```

```text
X_VALIDATION_FAILED: value did not match its schema
  cause: postId: expected a uuid, received "abc"; notify: expected a boolean, received "yes"
  fix:   send input with the field(s) named in cause corrected to the expected type
```

`error.issues` is `{ path, expected, received, message }[]` with paths like `items[0].price`;
`formatIssues()` renders one line per issue for the dev overlay. `validate()` never throws and
returns the Standard Schema result. Async libraries: `parseAsync()` / `validateAsync()`.

This package is tier 0 and cannot import `@ultimat3/core`, so `SchemaError` reproduces
`UltimateError` structurally and carries the same `Symbol.for('ultimate.error')` brand —
`isUltimateError()` from core matches it. Register the codes once from any package that imports
both: `registerErrorCodes(SCHEMA_ERROR_CODES)`.

## Swapping the library

The builtin validators are small and dependency-free so a fresh install has zero deps.
**ArkType is the intended production default**; Zod and Valibot work identically because all
three implement Standard Schema v1.

```ts
import { configureSchemaProvider } from '@ultimat3/schema';
import { arkNamespace, arkToNode } from './ark';   // your ~40-line adapter

configureSchemaProvider({ vendor: 'arktype', t: arkNamespace, introspect: arkToNode });
```

`t` reads the active provider on every access, so modules that imported `t` earlier pick up the
swap. `introspect()` is what OpenAPI/MCP generation needs; a provider without it throws
`X_SCHEMA_UNSUPPORTED` with the exact fix rather than emitting an empty request body.

## JSON Schema and coercion

```ts
toJsonSchema(publishPost);                    // OpenAPI 3.1 (2020-12)
toMcpInputSchema(publishPost);                // MCP tools/list (draft-07, no $schema)
parse(publishPost, coerceQuery(publishPost, url.searchParams));
```

Coercion is separate from validation on purpose: only the HTTP layer has strings that mean
numbers. `coerceQuery` promotes repeated params to arrays and leaves anything ambiguous
untouched so validation still produces the real error.
