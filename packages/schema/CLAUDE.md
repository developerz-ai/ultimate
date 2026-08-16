# @ultimat3/schema — agent notes

Tier 0. **Imports no `@ultimat3/*` package — not even `@ultimat3/core`.**

| Rule | |
|---|---|
| Deps | none (`bun-types` only) |
| Errors | `SchemaError` mirrors `UltimateError` field-for-field; keep `Symbol.for('ultimate.error')` |
| New validator | add to `validators.ts` **and** `TNamespace` **and** `t.ts` **and** `json-schema.ts` |
| IR | every schema carries `.node: SchemaNode`; generators read that, never the closure |
| **Issue messages** | the shape of the rejected value, **never its content** — see `describe-value.ts` |
| Coercion | HTTP boundary only — never call it from actions, jobs or MCP |
| Exports | explicit in `src/index.ts`; no `export *`; a namespace member and its free function ship together (`t.nullable`/`nullableSchema`) |
| Re-exports | `action`, `query`, `jobs`, `entity` re-export `t` verbatim so an authoring file imports one package — never let them wrap or copy it |

Module order (no cycles):
`describe-value → node → builder → money-value → validators → discriminated-union → provider → t`.
`standard.ts` and `errors.ts` depend on nothing but each other.

**An issue message is a public surface.** `@ultimat3/http` folds it into `X_BODY_INVALID`'s `cause`,
which is returned to the caller AND interpolated into the log line — and core's logger redacts by
KEY, so a value baked into a string has no key left to redact. `'password'` being in `redactedKeys`
did not help: `expected(…, value)` had already written `received "hunter2"` before the logger saw
it. Every rejected value goes through `describeValue`, which reports length and type and nothing
else. No dev flag re-enables the echo — one misconfigured environment is the same breach, and a dev
overlay already holds the raw body. `describe-value.test.ts` is the enforcement.

`X_SCHEMA_DISCRIMINANT_INVALID` is thrown where a `discriminatedUnion` is BUILT, not where a value
is parsed. A member with no literal at the discriminant, or a second member claiming a tag the
first already owns, can never be routed to — so it is wrong for every input, and the first import
of the authoring file is the earliest honest place to say so.

`SCHEMA_ERROR_CODES` in `errors.ts` is data, not a `registerErrorCodes()` call — this package is
tier 0 and cannot import `@ultimat3/core` to reach it. `@ultimat3/core`'s `schema-error-codes.ts`
carries a duplicate of these titles and registers them unconditionally, so every process gets the
real titles just by importing core. Add a code here **and** update that duplicate in the same
change — `schema-error-codes-pin.test.ts` in `@ultimat3/cli` fails the build if they disagree.

`MoneyValue` in `money-value.ts` — its own file, because it is the only builtin whose *shape* other
packages alias — is the framework's **one** declaration of a money value. Tier 0 is
the only tier every package may import, and `@ultimat3/money`'s `Money` and `@ultimat3/entity`'s
`MoneyValue` are aliases of it. Never let either restate the shape: it was three structural copies,
entity's had a `bigint` `minor`, and a row that layer decoded then failed both `t.money` and
`JSON.stringify`. `minor` stays a `number` for the same reason it is a `number` here — this node is
the OpenAPI contract, and money crosses every wire the framework projects.

`MoneyValue.scale` is the **optional** decimal exponent `minor` counts in, `0…MAX_MONEY_SCALE`
(15, the last power of ten that is itself a safe integer). Absent means the currency's own minor
unit, which is every value that predates it — so `{ minor, currency }` parses to exactly
`{ minor, currency }`, key for key, and the validator adds nothing. What a legal scale is lives in
`isMoneyScale` here and nowhere else; `@ultimat3/money` imports it rather than restating the
bound. Adding it to the type means adding it in three more places in the same change — the node's
`properties`, `json-schema.ts` (optional, never `required`, or a generated client refuses a value
this validator accepts) and `coerce.ts` (a query string carries it as text like everything else).

`t` delegates through `schemaProvider()` on every property access — that is what makes
`configureSchemaProvider()` work for modules that already imported `t`. Do not cache members.

```bash
bun test                      # from packages/schema
bun run typecheck
```

Gotchas:
- `Schema<In, Out>` splits input from output: `.default()` makes the key optional on input and
  present on output. Object key optionality is derived from that — don't hand-roll it.
- `AnySchema = Schema<unknown, unknown>` is the general constraint. Never `any`.
- Unknown object keys are dropped by design; JSON Schema says `additionalProperties: false`.
- Adding a `SchemaKind` means updating `json-schema.ts` and `coerce.ts` in the same commit.
- **Prefer a new `SchemaNode` FIELD to a new `SchemaKind`.** Every consumer that switches on `kind`
  has a `default:` that degrades quietly — `json-schema.ts` emits `{}`, `coerce.ts` passes the raw
  value through, `@ultimat3/action`'s `sample-input.ts` answers `null` — and they live in packages
  a schema change is not allowed to edit. `refinements` and `discriminant` are both fields for that
  reason: a refined string still reads as a string, and a discriminated union still reads as a
  union, everywhere. `lazy` and `tuple` cannot be — which is why neither has shipped.
- A refinement is carried as a **declaration** (`name`, `message`, `path`), never a closure: a
  predicate cannot cross into OpenAPI or an MCP tool schema, and `refine`'s `message` is rendered
  verbatim on both — so it states the rule and never interpolates a value.
- `@ultimat3/action`'s `sampleInput` does not read `refinements`, so a contract test over a refined
  schema reports `X_CONTRACT_DRIFT` exactly as it already does for a bare `pattern`. Documented
  there; fixing it is that package's change, not this one's.
