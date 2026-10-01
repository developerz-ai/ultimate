# 15 — Admin: detail, form, actions, audit

> Part of [`overview.md`](overview.md). Depends on: 13. Tier: 5.

Rule: an admin action is an `action` with a button. Its input form, its confirmation, when it
shows, and its audit row all come from the declaration.

Evidence, same admin app: 112 panels and 38 related-row tables on detail pages; 103 input groups
over 429 inputs; 47 member actions, 34 buttons of which 23 are conditional on the row's state;
27 batch actions held up by 334 lines of modal script and a framework patch; history on 34
models through a home-made reader. It also patched its admin framework because custom collection
actions were never authorized — the defect Ultimate's single gate
(`packages/admin/src/authz.ts:92`) already rules out.

## Files to change
| File | Change | Today |
|---|---|---|
| `packages/admin/src/detail.tsx:93-104` | sections; related-rows tables | one flat `<dl>` of every field |
| `packages/admin/src/form.tsx:60` | groups, hints, create-only / edit-only fields | one flat list |
| `packages/admin/src/resource.ts` | `sections`, `related`, `formGroups` | none |
| `packages/admin/src/registry.ts:155-167` | `AdminAction.when?: (row) => boolean`, `batch?: true` | no row condition; no batch |
| `packages/admin/src/detail.tsx:80-91` | pass the row to the action decision | the detail view passes no row |
| `packages/admin/src/actions.tsx:34` | render the action's input schema as a form | a button only |
| `packages/admin/src/list.tsx` | row selection + batch bar | no selection |
| `packages/admin/src/audit.ts:94` | a shipped Postgres `AuditSink`; `entries()` reads it | a memory ring only |

## Steps
1. **Sections.** `sections: [{ titleKey, fields }]`; fields named in no section fall into a
   default one, so adding a column never hides it.
2. **Related rows.** `related: ['comments']` reads the entity's own relations
   (`packages/entity/src/relations.ts`) and renders the related resource's list — its columns,
   its row scope, its policy — filtered to this row. No second table definition.
3. **Form groups.** `formGroups` mirrors `sections`; `hintKey` per field through `t()`;
   `on: 'create' | 'update'` for a field that exists on one side only.
4. **Action input.** An action with an input schema renders it with `Field` / `useForm`
   (`packages/ui/src/index.ts:117,121,255-282`) and maps the refusal's issues back to fields.
   No schema, no form: a confirm only.
5. **Row state.** `when(row)` decides the button on the detail and on each list row. The server
   re-evaluates it before running: a hidden button is not an authorization. A `when` that fails
   server-side is `X_ADMIN_ACTION_NOT_APPLICABLE`, naming the action and the row.
6. **Batch.** `batch: true` puts the action in the list's batch bar. It runs once per selected
   row through the same gate (`packages/admin/src/action-gate.ts:122`), reports
   done / refused / failed counts honestly, and audits each row. Above a threshold it enqueues a
   job per chunk; the threshold is a declared number.
7. **Audit.** The sink writes one table in the framework schema; the detail's history card and
   `entries()` read it. Use `appendOnly` when plan 102 slice 04 has landed. What a *domain* audit
   row means stays the app's (`docs/idea/19-mechanism-not-convention.md:89`).
8. Selection, batch bar and action forms are islands. Measure the admin surface and raise its
   budget by that amount with the reason in the same diff.

## Tests
- `packages/admin/src/detail-sections.test.ts`: unsectioned fields still render.
- `packages/admin/src/related-rows.test.ts`: related list honours the related resource's row
  scope and policy.
- `packages/admin/src/action-when.test.ts`: button hidden when `when` is false; a forged call is
  refused server-side.
- `packages/admin/src/batch-action.test.ts`: 3 rows, 1 refused by policy → 2 done, 1 refused,
  3 audit entries.
- `packages/admin/src/audit-pg.contract.test.ts`: entries survive a restart and page by keyset.
- Command: `bun test packages/admin/src/batch-action.test.ts`.

## Done when
- An "activate" action declared with `when: (row) => !row.active` and `batch: true` appears on
  inactive rows, in the batch bar, and as one MCP tool — from one declaration.
- The admin's history card shows entries written before the last process restart.
