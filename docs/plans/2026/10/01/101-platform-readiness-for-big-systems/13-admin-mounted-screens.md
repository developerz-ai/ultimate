# 13 — Admin: the generated screens are served

> Part of [`overview.md`](overview.md). Depends on: 10. Tier: 5.

Rule: `defineAdmin({ entities: [posts] })` is a working list, detail and form at a URL. An app
writes no page, no screen glue and no repo adapter to get them.

Evidence: the package exports the list, detail and form components, but a generated route's
`component` is `null` (`packages/admin/src/routes.ts:45`) and the registry says "the host binds
an adapter" (`packages/admin/src/registry.ts:82-87`). The deployed demo wrote that host by hand —
`repo.ts` 162, `screen.ts` 160, `views.tsx` 181 lines under
`dummy/social-media-clone/apps/admin/app/admin/`, plus a `page.tsx` per resource — and `x new`
emits an `<h1>` (`packages/cli/src/templates/scaffold-app.ts:231-262`). The surveyed admin app
registered 96 resources with zero route code. A downstream Ultimate app gave up on generated
CRUD entirely (`entities: []`).

## Files to change
- `packages/admin/src/routes.ts:40-50` — a generated view gets its component, guarded exactly as a
  custom page is (`guardedPage`).
- `packages/admin/src/` (new `repo-entity.ts`) — the one adapter from an entity's typed handle
  (`database()`, `packages/entity/src/index.ts:31`) to `AdminRepo`
  (`packages/admin/src/registry.ts:126-139`): verbs, keyset bound, filters → `where`, `count`.
- `packages/admin/src/admin.ts:60-65` — `defineAdmin` takes the app's `db` handle once; a
  per-resource `repo` stays as the override.
- `packages/cli/src/` — the admin mount: one catch-all under the admin base path serving every
  admin route, in `x dev` and the container.
- `packages/cli/src/templates/scaffold-app.ts:231-262`, `packages/cli/src/templates/admin.ts:22` —
  the scaffold declares `defineAdmin`; the generator derives `listFields` from the entity instead
  of hard-coding `['id', 'title', 'createdAt']`.
- `dummy/social-media-clone/apps/admin/app/admin/` — delete `repo.ts`, `screen.ts`, `views.tsx`
  and the per-resource pages once the package serves them.

## Steps
1. Read the demo's three files first: they are the specification of what the package must own.
   Move the logic, do not rewrite it; their tests move with it.
2. Tenancy and policy are the handle's and the admin gate's (`packages/admin/src/crud.ts:57`,
   `:175,282,333`). The adapter adds no predicate of its own
   (`packages/admin/CLAUDE.md:10`); slice 14 adds declared row scoping.
3. Custom pages keep working unchanged (`packages/admin/src/pages.ts:27-36`). A resource that
   wants its own list still passes a component: the override, not a second path.
4. The memory driver binds too, so the admin renders in `bun test` with no database.
5. Admin routes stay one render mode (`packages/admin/src/routes.ts:47-50`). Measure the admin
   surface's budget after the screens mount; raise by the measured amount with the reason.

## Tests
- `packages/admin/src/repo-entity.test.ts`: list, keyset page, find, create, update, destroy and
  `count` over a fixture entity on the memory driver; a tenant-scoped entity never returns another
  org's row.
- `packages/admin/src/mounted-screens.test.ts`: `defineAdmin({ entities, db })` answers the list,
  detail and form routes with rendered rows; an actor without the permission gets the refusal.
- `scaffold-smoke`: a new app's `/admin` lists a generated resource.
- Command: `bun test packages/admin/src/repo-entity.test.ts`.

## Done when
- The demo app's admin has no `repo.ts`, `screen.ts` or `views.tsx`, and
  `bun run scripts/reference-app-gate.ts` is green.
- `x new` then `x g resource widget --admin` then `x dev`: `/admin/widgets` lists rows.
