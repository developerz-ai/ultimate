# apps/admin

The operator dashboard, mounted at `/admin`. Generated from the entities — you declare a table and
it gets a list, a detail view, a form, filters and validation, because all of that is already in
the entity's columns and invariants.

## What is derived, and what you must say out loud

| Derived from the entity | Must be declared |
|---|---|
| field type and widget, from the column kind | which fields are sensitive |
| read-only, when the default is generated (`uuid()`, `defaultNow()`, `onUpdateNow()`) or the column is a key | the label field |
| filters and sorting, from indexed and unique columns | a fixed currency |
| validation, from the entity's own schema | per-resource operation whitelists |

## One declaration, no host code

`app/admin/admin.ts` is the whole dashboard: `defineAdmin({ entities, db, … })`. The list, detail
and form of each entity, the dashboard, search, the audit trail and the jobs screen are the
framework's, served under `/admin` by `x dev` and the container. This app has no `page.tsx`, no
repo adapter and no screen glue — `app/admin/mounted.test.ts` fails if a page file appears.

## Three seams

1. **Actions** — project a real `action` onto a row. It keeps its own policy, so a button here and
   a call over MCP are the same decision.
2. **Per-resource overrides** — fields, list columns, default sort, page size, and which operations
   exist at all.
3. **Pages** — `pages: [opsPage]`. A screen no generator would write, in the same route table and
   behind the same gate as a generated one.

## View-only is a permission, not a UI state

There is no read-only *flag*. An operator who holds `admin:read` and not `admin:write` cannot
mutate anything, and the same decision that refuses the call is what declines to render the button.
A button you cannot press is never drawn — and hiding a button is never what stops the write.

The demo's `admin/admin` account is exactly this: `admin:read` only.

## The button and the call

Screens are `hydrate: 'never'`, so a control is a **native form submit** posted at the row's own
URL — `POST /admin/users/<id>` with the action's name. The framework's mount answers it through
`invokeAdminAction`: the same decision that drew the button. A refusal is a 403 page naming the
permission, and it is on the audit log.

## Not a second front door

The dashboard has **no session of its own** — it reads the actor the app already resolved for the
request. Every mutation and every denial is written to the audit log with a before/after diff.
Its MCP surface exposes exactly the tools that actor could have clicked, with the same policies.

## Commands

`x dev` then open `/admin` · `x policy explain <subject>` · `x entities show <name> --json`
