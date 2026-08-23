// Single responsibility: the DDL `BuiltinAdapter` expects. Exported as plain strings so an app
// can paste them into a migration and read EXACTLY what auth stores — verifiable by reading,
// never by trusting.
//
// What is at rest, stated column by column rather than as a claim:
//
// | Column | Holds |
// |---|---|
// | `x_users.password_hash` | an argon2id digest, never the password |
// | `x_users.recovery_code_hashes` | SHA-256 digests, never the codes (`mfa.ts`) |
// | `x_users.mfa_secret` | **the base32 TOTP seed, in the clear** — see below |
// | `x_accounts.access_token` / `refresh_token` | **nothing.** The framework writes `null` |
// | `x_sessions.*`, `x_verifications.token_hash` | digests and metadata, never a token |
//
// `mfa_secret` is the one plaintext secret this schema still holds, and it is stated here rather
// than glossed: a TOTP seed is symmetric, so verifying a code requires the seed itself and a
// digest cannot replace it. Encrypting it needs a key-management seam this package does not have,
// which is a design change and not a patch — DEFERRED, deliberately, and written down so nobody
// reads the header above as covering it. `mfa.ts`'s "a database dump is not a permanent MFA
// bypass" is true of the recovery CODES and not of the seed.
//
// The two `x_accounts` token columns are kept in the DDL and written `null`: they held live
// provider credentials in the clear and nothing in this package ever read them back
// (`oauth-login.ts`'s `accountFor`). The columns stay so an app that deliberately stores tokens
// through its own `linkAccount` has somewhere to put them, and so an existing deployment needs
// no migration to stop.

export const X_USERS_TABLE = `create table if not exists x_users (
  id                    uuid primary key,
  email                 text not null unique,
  email_verified_at     timestamptz,
  password_hash         text,
  org_id                uuid,
  roles                 text[] not null default '{}',
  permissions           text[] not null default '{}',
  scopes                text[] not null default '{}',
  external_id           text unique,
  -- The base32 TOTP seed, in the clear. A seed is symmetric: a digest cannot verify a code.
  -- Encryption at rest is deferred and needs a key-management seam - see the header.
  mfa_secret            text,
  recovery_code_hashes  text[] not null default '{}',
  disabled_at           timestamptz,
  created_at            timestamptz not null default now()
);
create index if not exists x_users_org_id_idx on x_users (org_id)`;

/**
 * The two columns `x_users` gained in 1.3.0, as the statements an app already running 1.2 runs
 * once. Both are additive and both have a default, so the migration is not a rewrite and takes no
 * exclusive lock beyond the catalog update.
 */
export const X_USERS_MIGRATION_1_3: readonly string[] = Object.freeze([
  `alter table x_users add column if not exists scopes text[] not null default '{}'`,
  'alter table x_users add column if not exists external_id text',
  'create unique index if not exists x_users_external_id_key on x_users (external_id)',
  'create index if not exists x_users_org_id_idx on x_users (org_id)',
]);

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
create index if not exists x_sessions_absolute_expires_at_idx on x_sessions (absolute_expires_at);
create index if not exists x_sessions_created_at_idx on x_sessions (created_at)`;

export const X_ACCOUNTS_TABLE = `create table if not exists x_accounts (
  id                    uuid primary key,
  user_id               uuid not null references x_users (id) on delete cascade,
  provider              text not null,
  provider_account_id   text not null,
  -- Written NULL by the framework. Nothing reads them back, and a live provider credential at
  -- rest turns a database dump into third-party access. Kept for an app's own linkAccount().
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
