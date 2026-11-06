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

/** Four deletes in one statement; the count is everything that went. */
export const SQL_OAUTH_PURGE = `
with codes as (delete from x_oauth_codes where expires_at < $1 returning 1),
tokens as (delete from x_oauth_tokens where expires_at < $1 returning 1),
devices as (delete from x_oauth_devices where expires_at < $1 returning 1),
grants as (
  delete from x_oauth_grants where revoked_at < $1 or refreshed_at < $2 returning 1
)
select ((select count(*) from codes) + (select count(*) from tokens)
  + (select count(*) from devices) + (select count(*) from grants))::int as n
`;
