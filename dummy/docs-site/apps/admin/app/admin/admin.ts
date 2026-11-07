// The whole admin dashboard. `defineAdmin()` serves a list, a detail and a form for every entity
// below at /admin/<entity> — the columns, filters, validation and labels are derived from the
// entity, the rows are read through the app's own typed handle, and `x dev` mounts the screens.
// There is no page file, no repo adapter and no screen glue to write.
//
// It also ships an MCP surface over the same resources, so the user's agents can drive the user's
// product with the user's permissions (`adminMcp`).
import { db } from '@docs-site/db';
import { adminEntitiesOf, defineAdmin } from '@ultimat3/admin';

export const admin = defineAdmin({
  // Every entity the handle serves: `x g entity` adds one there, and it is an admin screen on
  // the next boot. Name them one by one instead — `entities: [post]` — to leave a table out.
  entities: adminEntitiesOf(db),
  db,
  // Who may do what is the app's role map (shared/roles.ts), asked permission by permission:
  // `admin:read` + `<table>:read` to look, `admin:write` + `<table>:write` to create or edit,
  // `admin:destroy` + `<table>:delete` to delete. `x g entity` grants a new table's three to
  // the `admin` role; a role holding only the two `:read` grants is a view-only operator.
  // Per-entity overrides — list columns, scopes, a row scope, which columns are sensitive — go in
  // `resources: { <entity>: … }`. `x g resource <name> --admin` writes one and lists it here.
});
