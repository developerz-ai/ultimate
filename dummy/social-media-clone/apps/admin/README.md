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

## Three seams, and no "add a page" API

1. **Actions** — project a real `action` onto the toolbar. It keeps its own policy, so a button
   here and a call over HTTP are the same decision.
2. **Per-resource overrides** — fields, list columns, default sort, page size, and which operations
   exist at all.
3. **Your own routes** — the generated routes are a plain list you mount alongside hand-written
   pages. Nothing stops you writing a custom screen; it just does not pretend to be generated.

## View-only is a permission, not a UI state

There is no read-only *flag*. An operator who holds `admin:read` and not `admin:write` cannot
mutate anything, and the same decision that refuses the call is what declines to render the button.
A button you cannot press is never drawn — and hiding a button is never what stops the write.

The demo's `admin/admin` account is exactly this: `admin:read` only.

## The button and the call, `As of 2026-08`

| Half | Where | Note |
|---|---|---|
| renders | `app/admin/views.tsx` → `RowActions` | one `<form method="post">` per allowed action, per row, carrying the row's id |
| answers | `api/admin-actions.ts` → `runAdminAction` | resolves the posted name against `defineAdmin()`'s registry, then `invokeAdminAction` |
| the URL | `shared/action-route.ts` | `derivePath('runAdminAction')`, read by both sides so neither types a path |

Pages here are `hydrate: 'never'`, so a control is a **form submit** — the browser's own form
handling is the client. The toolbar shipped as `<button type="button">` with no handler and no
enclosing form until 2026-08, backed by an `invokeAdminAction` nothing called: two halves that each
looked finished. A refusal at POST time is `X_ADMIN_ACTION_REFUSED` (403) with the permission that
refused it, because the button only renders when the decision allows — reaching the POST anyway is
a stale page, a hand-written request, or a destructive echo that was not given.

## Not a second front door

The dashboard has **no session of its own** — it reads the actor the app already resolved for the
request. Every mutation and every denial is written to the audit log with a before/after diff.
Its MCP surface exposes exactly the tools that actor could have clicked, with the same policies.

## Commands

`x dev` then open `/admin` · `x policy explain <subject>` · `x entities describe <name> --json`
