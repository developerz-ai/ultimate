// The DDL of the admin's one framework table, and nothing else: a LEAF module, so the boot's
// `FRAMEWORK_SCHEMA` (`@ultimat3/cli`) can apply it in every role through `@ultimat3/admin/schema`
// without pulling one screen, one view or one stylesheet into a worker's module graph.

/** The table. One name, read by this DDL and by `audit-pg.ts`'s insert and select. */
export const ADMIN_AUDIT_TABLE = 'x_admin_audit';

/**
 * Applied by the boot (`@ultimat3/cli`'s `FRAMEWORK_SCHEMA`), never by an app migration — the rule
 * every framework table follows. A plain table: there is no `appendOnly` entity modifier in this
 * tree, so "append-only" is `audit-pg.ts` issuing an `insert` and a `select` and nothing else.
 *
 * **Two indexes.** `(entity, entity_id, at desc, id desc)` is the detail page's history card: one
 * row's trail, newest first, a keyset seek with no sort. `(at desc, id desc)` is the audit screen.
 * `actor_id` and `org_id` have none — both are filters over the second index's order, and an index
 * is a write cost paid on every audited request.
 *
 * **`diff` is what the admin already redacted.** A sealed column and a `sensitive` field reach it
 * as `[redacted]` (`crud-input.ts`'s `rowDiff`), so no plaintext is ever a value in this table.
 *
 * **No retention and no purge**, for `x_audit`'s reason: how long a trail is kept is a legal
 * question with a different answer per app.
 */
export const SQL_ADMIN_AUDIT_TABLE = `
create table if not exists x_admin_audit (
  id          uuid        primary key,
  at          timestamptz not null,
  request_id  text        not null,
  actor_id    text        not null,
  actor_roles jsonb       not null,
  org_id      text,
  operation   text        not null,
  kind        text        not null,
  entity      text        not null,
  entity_id   text,
  permission  text        not null,
  outcome     text        not null,
  reason      text        not null,
  diff        jsonb       not null,
  recorded_at timestamptz not null default now()
);

create index if not exists x_admin_audit_entity_idx
  on x_admin_audit (entity, entity_id, at desc, id desc);

create index if not exists x_admin_audit_at_idx on x_admin_audit (at desc, id desc);
`;
