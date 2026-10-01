# 14 — Admin: the list an operator works in

> Part of [`overview.md`](overview.md). Depends on: 13. Tier: 5.

Rule: everything on a list page is derived from the entity or declared once on the resource.
A filter's options, a relation's label and a scope's count are never restated per screen.

Evidence, from an admin app of 96 resources: 490 filters (165 selects, 94 searchable pickers),
253 scopes, 293 computed columns, 143 status badges, 27 hand-written owner-scoping overrides —
and a second copy of 43 resources (1,970 identical lines) whose only purpose was a second
audience seeing its own rows in its own language.

## Files to change
| File | Change | Today |
|---|---|---|
| `packages/admin/src/list.tsx` | filter bar, scope tabs, per-list search box | no filter UI; filters exist as data only (`packages/admin/src/resource.ts:279`) |
| `packages/admin/src/` (new `list-request.ts`) | URL ⇄ `PageRequest.where` (`packages/admin/src/pagination.ts:65`) | no URL parser |
| `packages/admin/src/resource.ts:55-66` | `scopes`, `rows`, `columns` on `AdminResourceOptions` | none |
| `packages/admin/src/widgets.tsx:96-112` | enum → `Badge`; reference → the target's label | a plain `<span>`; the raw foreign-key value |
| `packages/admin/src/widgets.tsx:245-254` | reference input → `Combobox` over a derived lookup | a text input |
| `packages/admin/src/mcp-tools.ts:75` | the list tool takes `where` and `scope` | cursor and limit only |

## Steps
1. **Filters.** One control per derived filter (`packages/admin/src/fields.ts:150`): text →
   contains, enum → select from the entity's own values, boolean, date range, reference → picker.
   State lives in the URL; the server parses it into `AdminFilter[]`
   (`packages/admin/src/registry.ts:89-95`). An unknown field or operator in the URL is
   `X_ADMIN_FILTER_INVALID`, naming the field and the filters the resource does derive — never an
   ignored parameter.
2. **Scopes.** `scopes: { open: { where: [...] }, mine: { where: (actor) => [...] } }`, one
   `default`. Rendered as tabs; a count per tab only when the scope sets `count: true`, through
   `AdminRepo.count` (`packages/admin/src/registry.ts:138`), which nothing calls today. A count is
   a query on a big table: opt-in.
3. **Relation label.** A resource names its `label` field (default: the first text column). A
   reference cell shows it and links to the target; labels for one page are read in one batch
   through the entity tier's preload (`packages/entity/src/jit-preload.ts`). An N+1 here is a
   test failure, not a review comment.
4. **Relation picker.** One derived lookup per target resource — `contains` on its label, policy
   checked, keyset paged — serving every filter and input that references it. The surveyed app
   wrote that endpoint 42 times.
5. **Columns.** `columns: { total: { value: (row) => …, render: 'money' } }` for a computed
   column; a closed set of renderers — `badge`, `relative-time`, `money`, `truncate`, `link`,
   `json`. An app needing a seventh passes a component for that column.
6. **Row scoping.** `rows: (actor) => AdminFilter[]` on the resource, applied by the list, the
   search, the detail read, the lookup and the MCP list tool. One declaration replaces the
   surveyed app's second namespace. Locale and time zone are already per actor
   (`packages/admin/src/authz.ts:12-27`).
7. `Pagination` uses slice 07's `hrefFor`; the list needs no island for paging or filtering.

## Tests
- `packages/admin/src/list-request.test.ts`: URL → filters round trip; unknown field refused.
- `packages/admin/src/list-scopes.test.ts`: default scope applied; counts only where declared.
- `packages/admin/src/list-relations.test.ts`: 50 rows referencing 10 targets issue one label
  read (assert the statement count).
- `packages/admin/src/row-scope.test.ts`: an actor sees only `rows(actor)` on list, search,
  detail, lookup and the MCP tool — five assertions, one per projection.
- Command: `bun test packages/admin/src/list-request.test.ts`.

## Done when
- A resource with an enum, a reference and a timestamp column shows a working filter for each,
  with no option list written in the app.
- `bun run manifest` records each resource's scopes and row scope.
