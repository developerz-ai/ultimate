// The statements `postgresAuthServerStore` runs, spelled out so an operator can run the exact one a
// log line names. Every single-use transition is ONE conditional statement: the `where … is null`
// is re-evaluated after a lock wait, so two racing redemptions cannot both see a live row.

export const SQL_OAUTH_CLIENT_PUT = `
insert into x_oauth_clients
  (client_id, name, secret_hash, auth_method, redirect_uris, grant_types, scopes, resources, created_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
on conflict (client_id) do update set
  name = excluded.name, secret_hash = excluded.secret_hash, auth_method = excluded.auth_method,
  redirect_uris = excluded.redirect_uris, grant_types = excluded.grant_types,
  scopes = excluded.scopes, resources = excluded.resources
`;

export const SQL_OAUTH_CLIENT_GET = 'select * from x_oauth_clients where client_id = $1';

export const SQL_OAUTH_CODE_PUT = `
insert into x_oauth_codes
  (code_hash, grant_id, client_id, subject, scopes, resource, redirect_uri, code_challenge, expires_at)
values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`;

export const SQL_OAUTH_CODE_TAKE = `
update x_oauth_codes set used_at = $2 where code_hash = $1 and used_at is null returning *
`;

export const SQL_OAUTH_CODE_GET = 'select * from x_oauth_codes where code_hash = $1';

export const SQL_OAUTH_GRANT_PUT = `
insert into x_oauth_grants (id, client_id, subject, scopes, resource, created_at, refreshed_at)
values ($1, $2, $3, $4, $5, $6, $7)
`;

export const SQL_OAUTH_GRANT_GET = 'select * from x_oauth_grants where id = $1';

export const SQL_OAUTH_GRANT_TOUCH = 'update x_oauth_grants set refreshed_at = $2 where id = $1';

export const SQL_OAUTH_GRANT_REVOKE = `
update x_oauth_grants set revoked_at = $2 where id = $1 and revoked_at is null
`;

export const SQL_OAUTH_GRANTS_REVOKE = `
with revoked as (
  update x_oauth_grants set revoked_at = $3
  where subject = $1 and ($2::text is null or client_id = $2) and revoked_at is null
  returning 1
)
select count(*)::int as n from revoked
`;

/** Byte order on the id breaks a tie, as the memory store does: no collation decides the list. */
export const SQL_OAUTH_GRANTS_LIVE = `
select g.* from x_oauth_grants g
where g.subject = $1 and ($2::text is null or g.client_id = $2) and g.revoked_at is null
  and exists (
    select 1 from x_oauth_tokens t
    where t.grant_id = g.id and t.retired_at is null and t.expires_at > $3
  )
order by g.created_at, g.id collate "C"
`;

export const SQL_OAUTH_TOKEN_PUT = `
insert into x_oauth_tokens (token_hash, kind, grant_id, created_at, expires_at)
values ($1, $2, $3, $4, $5)
`;

export const SQL_OAUTH_TOKEN_GET = 'select * from x_oauth_tokens where token_hash = $1';

/** Retire the live one and insert its successor in ONE statement: no successor without the retire. */
export const SQL_OAUTH_REFRESH_ROTATE = `
with retired as (
  update x_oauth_tokens set retired_at = $2
  where token_hash = $1 and kind = 'refresh' and retired_at is null
  returning grant_id
)
insert into x_oauth_tokens (token_hash, kind, grant_id, created_at, expires_at)
select $3, 'refresh', grant_id, $4, $5 from retired
returning grant_id
`;

export const SQL_OAUTH_DEVICE_PUT = `
insert into x_oauth_devices
  (device_code_hash, user_code_hash, client_id, scopes, resource, interval_seconds, created_at, expires_at)
values ($1, $2, $3, $4, $5, $6, $7, $8)
`;

export const SQL_OAUTH_DEVICE_BY_USER_CODE =
  'select * from x_oauth_devices where user_code_hash = $1';

export const SQL_OAUTH_DEVICE_GET = 'select * from x_oauth_devices where device_code_hash = $1';

export const SQL_OAUTH_DEVICE_DECIDE = `
update x_oauth_devices set status = $2, subject = $3, granted_scopes = $4
where user_code_hash = $1 and status = 'pending' and expires_at > $5
returning *
`;

export const SQL_OAUTH_DEVICE_POLLED = `
update x_oauth_devices set last_polled_at = $2 where device_code_hash = $1
`;

export const SQL_OAUTH_DEVICE_CONSUME = `
update x_oauth_devices set status = 'consumed'
where device_code_hash = $1 and status = 'approved'
returning 1
`;

/**
 * Five deletes in one statement; the count is everything that went. Every CTE reads the same
 * snapshot, so a client whose last grant goes in this run still holds it here: it goes next run.
 * Only a self-registered client (`DYNAMIC_CLIENT_PREFIX`, `d_`) is reaped, and only with nothing
 * pointing at it.
 */
export const SQL_OAUTH_PURGE = `
with clients as (
  delete from x_oauth_clients c
  where left(c.client_id, 2) = 'd_' and c.created_at < $2
    and not exists (select 1 from x_oauth_grants g where g.client_id = c.client_id)
    and not exists (select 1 from x_oauth_codes o where o.client_id = c.client_id)
    and not exists (select 1 from x_oauth_devices d where d.client_id = c.client_id)
  returning 1
),
codes as (delete from x_oauth_codes where expires_at < $1 returning 1),
tokens as (delete from x_oauth_tokens where expires_at < $1 returning 1),
devices as (delete from x_oauth_devices where expires_at < $1 returning 1),
grants as (
  delete from x_oauth_grants where revoked_at < $1 or refreshed_at < $2 returning 1
)
select ((select count(*) from clients) + (select count(*) from codes) + (select count(*) from tokens)
  + (select count(*) from devices) + (select count(*) from grants))::int as n
`;
