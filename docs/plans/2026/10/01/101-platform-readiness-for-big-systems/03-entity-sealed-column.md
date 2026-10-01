# 03 — Entity: a sealed column

> Part of [`overview.md`](overview.md). Depends on: 01. Tier: 2.

Rule: a credential column is declared `.sealed()`; the row type stays `string`, the database
never sees the plaintext.

Evidence: one surveyed app wrote a 214-line column-encryption module; the scraping system
encrypts seven columns per connection through its ORM; `auth` stores `mfa_secret` in the clear
(`packages/auth/CLAUDE.md:121-122`).

## Files to change
- `packages/entity/src/` column builders — add `.sealed()` beside `.tenant()` / `.column(name)`
  (the chain documented at `wiki/Entities-And-Migrations.md:442`). Find the builder with
  `codegraph_explore "column modifier tenant()"`.
- `packages/entity/src/` row codec — `decodeRow` opens, the insert/update binding seals. One seam:
  the typed handle and a hand-written repo both pass through it.
- `packages/entity/src/` predicates — a sealed column in `where`, `orderBy` or a cursor is
  `X_ENTITY_SEALED_PREDICATE`.
- `packages/entity/src/` `$view` — a sealed column in a view list is `X_ENTITY_SEALED_IN_VIEW`:
  a view is what leaves the server.
- `packages/entity/src/` `$schema` — the entity's wire schema omits sealed columns. An action or
  query whose `output` is the entity therefore drops them at the output parse on every
  projection — HTTP, the typed client, MCP, a job result. Server code holding the decoded row
  still reads the plaintext; nothing that serialises the row does.
- `packages/entity/README.md`, `packages/entity/CLAUDE.md`.

## Steps
1. `text().sealed()` only. A sealed number or date has no use case in the evidence; refuse it at
   the type.
2. Purpose is derived: `entity:<table>.<column>`. An author never states it, so two columns cannot
   share one by accident.
3. DDL stays `text`. `x db gen` and drift need no new column type; confirm with the generator's
   test.
4. The memory driver seals too. A test that passes on memory and fails on Postgres is the defect
   `examples/dummy/packages/db/src/client.ts:15-35` records.
5. Sealed columns are excluded from `persist: true` records and from the record envelope: a sealed
   value never reaches a browser store.
6. `.sealed({ lookup: true })` uses slice 01's deterministic mode, as `encrypts …,
   deterministic: true` does: equality in `where` and `.unique()` are then allowed, and nothing
   else is — no ordering, no range, no `like`. Without `lookup`, every predicate is refused.
   While a retired key is still declared, equality expands to `in (…)` over slice 01's
   `sealAll`, and `.unique()` is only as strong as one key: `x doctor` reports a `lookup` column
   with more than one declared key as "re-seal pending", and the rotation's `backfill()` is what
   clears it.
7. Register both codes; the predicate's fix text names `.sealed({ lookup: true })` and says what
   it costs (equal plaintexts become visibly equal).
8. Legacy plaintext (`support_unencrypted_data` in Rails): `.sealed({ legacy: 'plaintext' })`
   reads a value that does not start with the wire prefix (`x1.`) as-is and seals it on the next
   write. A value that DOES start with the prefix must authenticate: a truncated or corrupted
   envelope is `X_SEAL_INVALID`, never "legacy". Otherwise one flipped byte would turn a
   tampered secret into accepted plaintext and the next write would seal the damage in. It is
   a migration aid with an end: the manifest lists every column still declaring it, and
   `x doctor` reports them. This is the path for `auth`'s `mfa_secret`
   (`packages/auth/CLAUDE.md:121-122`) if the owner takes it; see `overview.md` *Risks*.

## Tests
- `packages/entity/src/sealed-column.test.ts`: insert then raw `select` shows no plaintext; read
  returns it; `where({ password })` refused at type level and at runtime; a view naming it refused;
  a `lookup` column finds its row by equality and refuses `orderBy`; a `legacy` column reads a
  plaintext row and stores it sealed after one update, and refuses a corrupted `x1.` value.
- `packages/entity/src/sealed-egress.test.ts`, one assertion per way a row leaves the server: an
  action with `output: entity` answers without the column; the record envelope omits it; a
  `persist: true` record written to the browser store omits it; the MCP tool result omits it.
- A `.contract.test.ts` beside it against Postgres, same assertions.
- Command: `bun test packages/entity/src/sealed-column.test.ts`.

## Done when
- A column declared `.sealed()` round-trips through `database()`'s handle on both drivers.
- `bun run manifest` lists the column as sealed; `bun run typecheck` green.
