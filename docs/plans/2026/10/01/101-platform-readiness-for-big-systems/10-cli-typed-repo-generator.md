# 10 — CLI: the generator emits the typed repo

> Part of [`overview.md`](overview.md). Depends on: 03, 08. Tier: 5.

Rule: `x g entity` writes a repo over the typed handle. A generated file contains no `sql`
template literal, no `decodeRow` call and no hand-written tenant predicate.

Evidence: the template emits ``db().one<Physical>(sql`select * from …`)`` and
`where org_id = ${orgId}` (`packages/cli/src/templates/entity.ts:67-117`), while both tracked
apps read through `database({ … })` (`examples/dummy/packages/db/src/client.ts:44`). An
agent-written app followed the generator: 1,115 `sql` fragments in 104 files, 556 `decodeRow`
calls, 311 hand-written `org_id =` predicates, and a hand-rolled paging module because its
queries could not push a page into raw SQL.

## Files to change
- `packages/cli/src/templates/entity.ts:67-117` — `repoSource`.
- `packages/cli/src/templates/` scaffold — the app's `packages/db/src/client.ts` with
  `database({}, { driver })`, if `x new` does not already write one (check first).
- `packages/cli/src/generate-files.ts:120` (`case 'entity'`) and `:92` (`case 'resource'`) — add
  the new entity to the handle's entity set.
- `packages/cli/src/templates/resource.ts` — the generated query pages through the handle.
- `wiki/Entities-And-Migrations.md` — the repo section shows the handle.

## Steps
1. Read `dummy/social-media-clone/apps/web/app/tasks/repo.ts`: that is the target output.
2. `byId`, `listByOrg`, `insert` become handle calls. Tenant scoping is the handle's
   (`X_TENANCY_UNSCOPED`), so the generated code states no org predicate.
3. Registering the entity in `client.ts` is an edit to an existing file. Use the generator's
   existing "append to a list" mechanism if one exists (`x g resource` already edits the api
   index); otherwise emit the one line to add and fail loudly when the anchor is missing.
4. Money and sealed columns need no code in the repo: the handle's codec owns both (slice 03).
5. Where raw SQL is still right — a `query`'s `sql`, a migration — nothing changes. The template
   comment says which is which.
6. Add a guard template `repo-raw-sql`: a `sql` template literal in a `repo.ts` whose statement
   the handle can express (`select *` / `insert` / `update` / `delete` on one table) is a finding
   naming the handle call. Ships through slice 08's `scaffold-guards.ts` list.

## Tests
- `packages/cli/src/cmd-generate.test.ts`: the generated repo has no `` sql` ``, typechecks against
  a fixture app, and its three functions pass against the memory driver.
- `scaffold-smoke`: `x g entity widget` then `x verify` green.
- Command: `bun test packages/cli/src/cmd-generate.test.ts -t 'entity'`.

## Done when
- `x g entity widget --dry-run` lists a repo with zero `sql` literals.
- A scaffolded app, after `x g resource widget`, pages its list through the handle.
