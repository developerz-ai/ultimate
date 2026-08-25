# ✅ @ultimat3/schema

Tier 0. The validation seam. One schema declaration projects to a runtime validator, a TypeScript
type, a JSON Schema, an OpenAPI body, an MCP tool `inputSchema` and HTTP query coercion.

| Owns | Module |
|---|---|
| Standard Schema v1 types + `validate()` / `parse()` for **any** conforming library | `standard.ts` |
| the blessed `t` namespace | `t.ts` |
| builtin validators behind `t` | `validators.ts` |
| the introspectable IR every generator walks | `node.ts` |
| `Schema` factory, `Infer` machinery, `.refine()` | `builder.ts` |
| how a rejected value is described — its shape, never its content | `describe-value.ts` |
| a union routed by one literal key | `discriminated-union.ts` |
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
                                     // { minor: 2, currency: 'USD', scale: 6 } is $0.000002
  timeZone: t.timezone,              // real IANA validation, not an annotation
  cursor:   t.optional(t.cursor),
});

type PublishPost = Infer<typeof publishPost>;
```

| Value schemas | Factories | Methods |
|---|---|---|
| `string` `number` `boolean` `date` `uuid` `email` `url` | `object` `array` `enum` `literal` `union` `discriminatedUnion` `record` `optional` `nullable` `refine` | `.default(v)` `.optional()` `.nullable()` `.describe(s)` `.refine(r)` |
| `money` `timezone` `locale` `slug` `cursor` | `object(...).extend/.pick/.omit` | `string.min/.max/.pattern`, `number.min/.max/.int` |

`nullable` is a value the row holds; `optional` is the caller omitting the key. Both ship as a
namespace member (`t.nullable`) and a free function (`nullableSchema`) — symmetrically.

Unknown object keys are **dropped**, never forwarded — an action cannot be mass-assigned.

### Cross-field rules live on the schema

A rule the IR cannot state structurally still belongs to the schema, or it moves into a handler and
disappears from `openapi.json`, the MCP tool schema, the typed client and every form binding at
once — axiom 2 broken for every such rule in the product.

```ts
const booking = t.object({ startDate: t.date, endDate: t.date }).refine({
  name: 'end-after-start',                       // stable id → `x-ultimate-refinements`
  message: 'endDate must be after startDate',    // the rule, never the value
  path: ['endDate'],                             // which field the issue lands on
  check: (value) => value.endDate > value.startDate,
});
```

The predicate runs on the **parsed** output and only after the shape passed, so it compares coerced
values and never defends against a type the schema already refused. What ships in the IR is the
declaration, not the closure: `node.refinements`, projected as an `x-ultimate-refinements`
extension **and** appended to `description`, which is the only field an LLM reading a tool schema
is guaranteed to see. `.refine()` returns a plain `Schema`, so refining after `extend`/`pick`/`omit`
— which rebuild from the shape and would drop the rule — is a type error rather than a comment.

### `discriminatedUnion` names the branch it judged

```ts
const body = t.discriminatedUnion(
  'kind',
  t.object({ kind: t.literal('post'), slug: t.slug }),
  t.object({ kind: t.literal('page'), title: t.string.min(3) }),
);
```

`t.union` reports every member's reasons at once, so one bad field in a `post` body arrives as N
contradictory complaints naming fields the caller never sent. This routes on `kind` first and
reports that branch's issues only. A member with no literal (or enum) at the discriminant, or two
members claiming one tag, is `X_SCHEMA_DISCRIMINANT_INVALID` **where the union is built** — a
branch nothing can route to is wrong for every input, not for one request. The node stays
`kind: 'union'` with a `discriminant` beside it, so every existing IR consumer keeps working, and
JSON Schema gains `discriminator: { propertyName }`.

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
  cause: postId: expected a uuid, received a string of 3 characters; notify: expected a boolean, received a string of 3 characters
  fix:   send input with the field(s) named in cause corrected to the expected type
```

**An issue message names the shape of the rejected value, never its content**, and `received` on
the issue is empty for the same reason. `@ultimat3/http` folds these messages into
`X_BODY_INVALID`'s `cause`, which is returned to the caller *and* written to the log line — where
the logger redacts by key and a value baked into a string has no key left to redact. Echoing the
value meant a password-strength rule wrote every mistyped password to the central log index in
cleartext. There is no dev-only escape hatch: a flag is one misconfigured environment away from
being the same breach. `describe-value.ts` owns the rule and `describe-value.test.ts` enforces it.

**The issue's PATH is the same public surface**, so it too names only what the framework chose. A
`t.object` segment is a declared field name and stays as written; a `t.record` KEY is the caller's
data, so a failing record entry is named by POSITION — `meta[3]`, the segment `t.array` already
uses. `@ultimat3/http`'s `bodyInvalid` states this contract in its own doc block: the `issues` it
renders "name only facts the framework itself chose". A record keyed by an email address, a phone
number or a pasted credential wrote every one of them into the log index otherwise.

`t.number.int()` demands a **safe** integer. `2 ** 53` is a whole number, and accepting it here
meant the boundary answered 200 and the row write answered 500 for the same value. The published
JSON Schema carries the same bound: `minimum`/`maximum` at `±Number.MAX_SAFE_INTEGER`, or your own
bound where it is narrower.

`error.issues` is `{ path, expected, received, message }[]` with paths like `items[0].price`;
`formatIssues()` renders one line per issue for the dev overlay. `validate()` never throws and
returns the Standard Schema result. Async libraries: `parseAsync()` / `validateAsync()`.

This package is tier 0 and cannot import `@ultimat3/core`, so `SchemaError` reproduces
`UltimateError` structurally and carries the same `Symbol.for('ultimate.error')` brand —
`isUltimateError()` from core matches it. Register the codes once from any package that imports
both: `registerErrorCodes(SCHEMA_ERROR_CODES)`.

## Swapping the library

The builtin validators (`validators.ts`) are the shipped default — small, dependency-free, no
adapter to install. No ArkType, Zod or Valibot adapter ships in this package; swapping to one
means writing the ~40-line adapter below yourself. All three implement Standard Schema v1, so
any of them works identically once wired.

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
