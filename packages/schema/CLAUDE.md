# @ultimat3/schema — agent notes

Tier 0. **Imports no `@ultimat3/*` package — not even `@ultimat3/core`.**

| Rule | |
|---|---|
| Deps | none (`bun-types` only) |
| Errors | `SchemaError` mirrors `UltimateError` field-for-field **and message-for-message** (`code: title — cause`); keep `Symbol.for('ultimate.error')` |
| New validator | add to `validators.ts` **and** `TNamespace` **and** `t.ts` **and** `json-schema.ts` |
| IR | every schema carries `.node: SchemaNode`; generators read that, never the closure |
| **Issue messages** | the shape of the rejected value, **never its content** — see `describe-value.ts` |
| Coercion | HTTP boundary only — never call it from actions, jobs or MCP |
| Exports | explicit in `src/index.ts`; no `export *`; a namespace member and its free function ship together (`t.nullable`/`nullableSchema`) |
| Re-exports | `action`, `query`, `jobs`, `entity` re-export `t` verbatim so an authoring file imports one package — never let them wrap or copy it |

Module order (no cycles):
`char-count → describe-value → node → builder → money-value → validators → discriminated-union →
provider → t`. `char-count.ts` is imported by BOTH `validators.ts` (which rejects on length) and
`describe-value.ts` (which renders the length in the same message), because they disagreed: the
rule counted code points and the message counted UTF-16 units, so `t.string.min(3)` refused `'👍a'`
with "at least 3 chars, received a string of 3 characters".
`standard.ts` and `errors.ts` depend on nothing but each other. `iso-date.ts` imports nothing and
is imported by `validators.ts` and `coerce.ts` — the two doors a `t.date` string comes through, so
the rule that a clock time must carry an offset or `Z` has one copy, not one per door.

**An issue message is a public surface.** `@ultimat3/http` folds it into `X_BODY_INVALID`'s `cause`,
which is returned to the caller AND interpolated into the log line — and core's logger redacts by
KEY, so a value baked into a string has no key left to redact. `'password'` being in `redactedKeys`
did not help: `expected(…, value)` had already written `received "hunter2"` before the logger saw
it. Every rejected value goes through `describeValue`, which reports length and type and nothing
else, in CHARACTERS (`char-count.ts`) — the unit the rule that rejected it counts in. No dev flag
re-enables the echo — one misconfigured environment is the same breach, and a dev
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

`MoneyValue.currency` is bounded by `isCurrencyCode`, `isMoneyScale`'s twin, over
`CURRENCY_CODE_PATTERN` — the pattern **source**, exported because the two projections that cannot
call a predicate need the string: `json-schema.ts`'s published `pattern` and `@ultimat3/entity`'s
Postgres `~` CHECK (`currencyCheck`). It was four copies of `^[A-Z]{3}$` across three packages,
each individually correct, and only a psql session would have seen them diverge. Keep the pattern
inside the syntax ECMAScript, JSON Schema and POSIX ERE spell identically — anchors, a literal
class, a bounded repetition. `@ultimat3/entity`'s `currency-check.live.test.ts` is what proves a
real server still reads it the way the predicate does; a `\d` or a lookahead is where that stops.

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
- **An object parse reads every declared field with `Object.hasOwn` and answers a null-prototype
  object** — the same two halves `recordSchema` has. A raw `value[key]` read `toString` off the
  PROTOTYPE, so a field named after one was unsatisfiable for every input and its `.default()`
  never fired; a `{}` output let a declared `__proto__` field write through the setter. Never
  reintroduce either half, and never assume a parsed object has `Object.prototype` on it.
- `t.date` refuses a clock time with no offset and no `Z` (`iso-date.ts`): a zone-less string is a
  different instant per host `TZ`, and `coerceQuery` puts it one query parameter from the wire.
  A date-only string carries no clock time and is UTC by spec, so it still parses.
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
