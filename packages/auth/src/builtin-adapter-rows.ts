// Single responsibility: `x_*` rows as they arrive from the driver — `unknown` values under
// snake_case names — read into the domain objects `PostgresAuthAdapter` answers with. Typed
// readers, no `any`: a renamed column reads as its empty value here and fails a round-trip test,
// never as a silent `undefined`.

import type {
  AuthAccount,
  AuthApiKeyRecord,
  AuthSession,
  AuthUser,
  AuthVerification,
} from './adapter';

export type Row = Readonly<Record<string, unknown>>;

const textOrNull = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' ? value : null;
};

export const text = (row: Row, key: string): string => textOrNull(row, key) ?? '';

const flag = (row: Row, key: string): boolean => row[key] === true;

const list = (row: Row, key: string): readonly string[] => {
  const value = row[key];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
};

const dateOrNull = (row: Row, key: string): Date | null => {
  const value = row[key];
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  return null;
};

const date = (row: Row, key: string): Date => dateOrNull(row, key) ?? new Date(0);

export const toUser = (row: Row): AuthUser => ({
  id: text(row, 'id'),
  email: text(row, 'email'),
  emailVerifiedAt: dateOrNull(row, 'email_verified_at'),
  passwordHash: textOrNull(row, 'password_hash'),
  orgId: textOrNull(row, 'org_id'),
  roles: list(row, 'roles'),
  permissions: list(row, 'permissions'),
  scopes: list(row, 'scopes'),
  mfaSecret: textOrNull(row, 'mfa_secret'),
  recoveryCodeHashes: list(row, 'recovery_code_hashes'),
  externalId: textOrNull(row, 'external_id'),
  disabledAt: dateOrNull(row, 'disabled_at'),
  createdAt: date(row, 'created_at'),
});

export const toSession = (row: Row): AuthSession => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  tokenHash: text(row, 'token_hash'),
  createdAt: date(row, 'created_at'),
  absoluteExpiresAt: date(row, 'absolute_expires_at'),
  lastSeenAt: date(row, 'last_seen_at'),
  ip: textOrNull(row, 'ip'),
  userAgent: textOrNull(row, 'user_agent'),
  mfaSatisfied: flag(row, 'mfa_satisfied'),
});

export const toAccount = (row: Row): AuthAccount => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  provider: text(row, 'provider'),
  providerAccountId: text(row, 'provider_account_id'),
  accessToken: textOrNull(row, 'access_token'),
  refreshToken: textOrNull(row, 'refresh_token'),
  expiresAt: dateOrNull(row, 'expires_at'),
  createdAt: date(row, 'created_at'),
});

export const toVerification = (row: Row): AuthVerification => ({
  id: text(row, 'id'),
  purpose: text(row, 'purpose'),
  identifier: text(row, 'identifier'),
  tokenHash: text(row, 'token_hash'),
  expiresAt: date(row, 'expires_at'),
  consumedAt: dateOrNull(row, 'consumed_at'),
  createdAt: date(row, 'created_at'),
});

export const toApiKey = (row: Row): AuthApiKeyRecord => ({
  id: text(row, 'id'),
  prefix: text(row, 'prefix'),
  keyHash: text(row, 'key_hash'),
  userId: textOrNull(row, 'user_id'),
  orgId: textOrNull(row, 'org_id'),
  scopes: list(row, 'scopes'),
  lastUsedAt: dateOrNull(row, 'last_used_at'),
  expiresAt: dateOrNull(row, 'expires_at'),
  revokedAt: dateOrNull(row, 'revoked_at'),
  createdAt: date(row, 'created_at'),
});

/**
 * The columns of `row` whose names start with `prefix`, under their bare names: one side of a join
 * whose two tables share column names (`id`, `created_at`), aliased apart in the select list.
 */
export const unprefixed = (row: Row, prefix: string): Row =>
  Object.fromEntries(
    Object.entries(row)
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, value]) => [key.slice(prefix.length), value]),
  );
