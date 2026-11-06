// The DDL of the authorization server's five framework tables, and nothing else: a leaf, so the
// boot's `FRAMEWORK_SCHEMA` reads it beside `AUTH_TABLES` without the server's logic. Every secret
// column holds a SHA-256 digest, never the credential. Lists are SPACE-joined text: scope-tokens
// and URIs hold no space. Imports nothing.

export const AUTH_SERVER_TABLES = [
  'x_oauth_clients',
  'x_oauth_codes',
  'x_oauth_grants',
  'x_oauth_tokens',
  'x_oauth_devices',
] as const;

/**
 * Applied by the boot, never by an app migration. `create … if not exists` throughout; a new
 * column is an `alter table … add column if not exists`, never an edit to a `create`.
 */
export const SQL_AUTH_SERVER_TABLES = `
create table if not exists x_oauth_clients (
  client_id     text        primary key,
  name          text        not null,
  secret_hash   text,
  auth_method   text        not null,
  redirect_uris text        not null default '',
  grant_types   text        not null default '',
  scopes        text        not null default '',
  resources     text        not null default '',
  created_at    timestamptz not null
);

create table if not exists x_oauth_grants (
  id           text        primary key,
  client_id    text        not null,
  subject      text        not null,
  scopes       text        not null,
  resource     text,
  created_at   timestamptz not null,
  refreshed_at timestamptz not null,
  revoked_at   timestamptz
);

create index if not exists x_oauth_grants_subject_idx on x_oauth_grants (subject, client_id);

create table if not exists x_oauth_codes (
  code_hash      text        primary key,
  grant_id       text        not null,
  client_id      text        not null,
  subject        text        not null,
  scopes         text        not null,
  resource       text,
  redirect_uri   text        not null,
  code_challenge text        not null,
  expires_at     timestamptz not null,
  used_at        timestamptz
);

create table if not exists x_oauth_tokens (
  token_hash text        primary key,
  kind       text        not null,
  grant_id   text        not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  retired_at timestamptz
);

create index if not exists x_oauth_tokens_grant_idx on x_oauth_tokens (grant_id);

create table if not exists x_oauth_devices (
  device_code_hash text        primary key,
  user_code_hash   text        not null unique,
  client_id        text        not null,
  scopes           text        not null,
  resource         text,
  status           text        not null default 'pending',
  subject          text,
  granted_scopes   text,
  interval_seconds integer     not null,
  last_polled_at   timestamptz,
  created_at       timestamptz not null,
  expires_at       timestamptz not null
);
`;
