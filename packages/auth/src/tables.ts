// Single responsibility: the DDL `BuiltinAdapter` expects. Exported as plain strings so an app
// can paste them into a migration and read exactly what auth stores — no column holds a
// plaintext secret, and that is meant to be verifiable by reading, not by trusting.

export const X_USERS_TABLE = `create table if not exists x_users (
  id                    uuid primary key,
  email                 text not null unique,
  email_verified_at     timestamptz,
  password_hash         text,
  org_id                uuid,
  roles                 text[] not null default '{}',
  permissions           text[] not null default '{}',
  mfa_secret            text,
  recovery_code_hashes  text[] not null default '{}',
  disabled_at           timestamptz,
  created_at            timestamptz not null default now()
)`;

// `id` is the public half of the cookie; `token_hash` is sha256 of the secret half.
export const X_SESSIONS_TABLE = `create table if not exists x_sessions (
  id                    text primary key,
  user_id               uuid not null references x_users (id) on delete cascade,
  token_hash            text not null,
  created_at            timestamptz not null default now(),
  absolute_expires_at   timestamptz not null,
  last_seen_at          timestamptz not null default now(),
  ip                    text,
  user_agent            text,
  mfa_satisfied         boolean not null default false
);
create index if not exists x_sessions_user_id_idx on x_sessions (user_id);
create index if not exists x_sessions_absolute_expires_at_idx on x_sessions (absolute_expires_at)`;

export const X_ACCOUNTS_TABLE = `create table if not exists x_accounts (
  id                    uuid primary key,
  user_id               uuid not null references x_users (id) on delete cascade,
  provider              text not null,
  provider_account_id   text not null,
  access_token          text,
  refresh_token         text,
  expires_at            timestamptz,
  created_at            timestamptz not null default now(),
  unique (provider, provider_account_id)
)`;

// One live token per (purpose, identifier): issuing a new one overwrites the old.
export const X_VERIFICATIONS_TABLE = `create table if not exists x_verifications (
  id                    text primary key,
  purpose               text not null,
  identifier            text not null,
  token_hash            text not null,
  expires_at            timestamptz not null,
  consumed_at           timestamptz,
  created_at            timestamptz not null default now(),
  unique (purpose, identifier)
)`;

export const X_API_KEYS_TABLE = `create table if not exists x_api_keys (
  id                    text primary key,
  prefix                text not null unique,
  key_hash              text not null,
  user_id               uuid,
  org_id                uuid,
  scopes                text[] not null default '{}',
  last_used_at          timestamptz,
  expires_at            timestamptz,
  revoked_at            timestamptz,
  created_at            timestamptz not null default now()
)`;

/** Ordered by foreign-key dependency — run them top to bottom. */
export const AUTH_TABLES: readonly string[] = Object.freeze([
  X_USERS_TABLE,
  X_SESSIONS_TABLE,
  X_ACCOUNTS_TABLE,
  X_VERIFICATIONS_TABLE,
  X_API_KEYS_TABLE,
]);

export const AUTH_TABLE_NAMES: readonly string[] = Object.freeze([
  'x_users',
  'x_sessions',
  'x_accounts',
  'x_verifications',
  'x_api_keys',
]);
