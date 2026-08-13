# @ultimat3/schema — agent notes

Tier 0. **Imports no `@ultimat3/*` package — not even `@ultimat3/core`.**

| Rule | |
|---|---|
| Deps | none (`bun-types` only) |
| Errors | `SchemaError` mirrors `UltimateError` field-for-field; keep `Symbol.for('ultimate.error')` |
| New validator | add to `validators.ts` **and** `TNamespace` **and** `t.ts` **and** `json-schema.ts` |
| IR | every schema carries `.node: SchemaNode`; generators read that, never the closure |
| Coercion | HTTP boundary only — never call it from actions, jobs or MCP |
| Exports | explicit in `src/index.ts`; no `export *`; a namespace member and its free function ship together (`t.nullable`/`nullableSchema`) |
| Re-exports | `action`, `query`, `jobs`, `entity` re-export `t` verbatim so an authoring file imports one package — never let them wrap or copy it |

Module order (no cycles): `node → builder → validators → provider → t`.
`standard.ts` and `errors.ts` depend on nothing but each other.

`SCHEMA_ERROR_CODES` in `errors.ts` is data, not a `registerErrorCodes()` call — this package is
tier 0 and cannot import `@ultimat3/core` to reach it. `@ultimat3/core`'s `schema-error-codes.ts`
carries a duplicate of these titles and registers them unconditionally, so every process gets the
real titles just by importing core. Add a code here **and** update that duplicate in the same
change — `schema-error-codes-pin.test.ts` in `@ultimat3/cli` fails the build if they disagree.

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
