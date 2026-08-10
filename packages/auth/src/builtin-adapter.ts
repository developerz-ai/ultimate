// Single responsibility: the one blessed `AuthAdapter`, backed by Postgres through
// `@ultimat3/db`. The `DbClient` is injected (defaulting to `db()`) so tests and the CLI can
// drive it without a database. Rows arrive as `unknown` and are read through the small typed
// readers below — no `any`, and a column rename fails loudly instead of producing `undefined`.

import { type DbClient, db, sql } from '@ultimat3/db';
import type {
  AuthAccount,
  AuthAdapter,
  AuthApiKeyRecord,
  AuthSession,
  AuthUser,
  AuthVerification,
  CreateUserInput,
  SessionPatch,
  UserPatch,
} from './adapter';
import { authWriteFailed } from './errors';

type Row = Readonly<Record<string, unknown>>;

const textOrNull = (row: Row, key: string): string | null => {
  const value = row[key];
  return typeof value === 'string' ? value : null;
};

const text = (row: Row, key: string): string => textOrNull(row, key) ?? '';

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

const toUser = (row: Row): AuthUser => ({
  id: text(row, 'id'),
  email: text(row, 'email'),
  emailVerifiedAt: dateOrNull(row, 'email_verified_at'),
  passwordHash: textOrNull(row, 'password_hash'),
  orgId: textOrNull(row, 'org_id'),
  roles: list(row, 'roles'),
  permissions: list(row, 'permissions'),
  mfaSecret: textOrNull(row, 'mfa_secret'),
  recoveryCodeHashes: list(row, 'recovery_code_hashes'),
  disabledAt: dateOrNull(row, 'disabled_at'),
  createdAt: date(row, 'created_at'),
});

const toSession = (row: Row): AuthSession => ({
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

const toAccount = (row: Row): AuthAccount => ({
  id: text(row, 'id'),
  userId: text(row, 'user_id'),
  provider: text(row, 'provider'),
  providerAccountId: text(row, 'provider_account_id'),
  accessToken: textOrNull(row, 'access_token'),
  refreshToken: textOrNull(row, 'refresh_token'),
  expiresAt: dateOrNull(row, 'expires_at'),
  createdAt: date(row, 'created_at'),
});

const toVerification = (row: Row): AuthVerification => ({
  id: text(row, 'id'),
  purpose: text(row, 'purpose'),
  identifier: text(row, 'identifier'),
  tokenHash: text(row, 'token_hash'),
  expiresAt: date(row, 'expires_at'),
  consumedAt: dateOrNull(row, 'consumed_at'),
  createdAt: date(row, 'created_at'),
});

const toApiKey = (row: Row): AuthApiKeyRecord => ({
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
 * A patch column is written as `case when <set> then <value> else <column> end` rather than
 * assembled into dynamic SQL: `null` stays a meaningful value ("clear this field") and the
 * statement text remains constant, so the query plan is cached and nothing is interpolated.
 */
export class BuiltinAdapter implements AuthAdapter {
  readonly name = 'builtin-postgres';
  readonly #db: DbClient;

  constructor(client: DbClient = db()) {
    this.#db = client;
  }

  async findUserByEmail(email: string): Promise<AuthUser | null> {
    const row = await this.#db.one<Row>(sql`select * from x_users where email = ${email}`);
    return row === null ? null : toUser(row);
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    const row = await this.#db.one<Row>(sql`select * from x_users where id = ${id}`);
    return row === null ? null : toUser(row);
  }

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const row = await this.#db.one<Row>(sql`
      insert into x_users (id, email, password_hash, org_id, roles, created_at)
      values (${input.id}, ${input.email}, ${input.passwordHash}, ${input.orgId},
              ${[...input.roles]}, ${input.createdAt})
      returning *`);
    // An empty `returning` means no row landed. A user fabricated from `{}` would travel back
    // out of `register()` as a successful registration with no identity in it.
    if (row === null) throw authWriteFailed('createUser', 'x_users');
    return toUser(row);
  }

  async updateUser(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const row = await this.#db.one<Row>(sql`
      update x_users set
        password_hash = case when ${patch.passwordHash !== undefined}
          then ${patch.passwordHash ?? null} else password_hash end,
        email_verified_at = case when ${patch.emailVerifiedAt !== undefined}
          then ${patch.emailVerifiedAt ?? null} else email_verified_at end,
        mfa_secret = case when ${patch.mfaSecret !== undefined}
          then ${patch.mfaSecret ?? null} else mfa_secret end,
        recovery_code_hashes = case when ${patch.recoveryCodeHashes !== undefined}
          then ${[...(patch.recoveryCodeHashes ?? [])]} else recovery_code_hashes end,
        disabled_at = case when ${patch.disabledAt !== undefined}
          then ${patch.disabledAt ?? null} else disabled_at end,
        roles = case when ${patch.roles !== undefined}
          then ${[...(patch.roles ?? [])]} else roles end
      where id = ${id}
      returning *`);
    return row === null ? null : toUser(row);
  }

  async getSession(id: string): Promise<AuthSession | null> {
    const row = await this.#db.one<Row>(sql`select * from x_sessions where id = ${id}`);
    return row === null ? null : toSession(row);
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    await this.#db.execute(sql`
      insert into x_sessions (id, user_id, token_hash, created_at, absolute_expires_at,
                              last_seen_at, ip, user_agent, mfa_satisfied)
      values (${session.id}, ${session.userId}, ${session.tokenHash}, ${session.createdAt},
              ${session.absoluteExpiresAt}, ${session.lastSeenAt}, ${session.ip},
              ${session.userAgent}, ${session.mfaSatisfied})`);
    return session;
  }

  async updateSession(id: string, patch: SessionPatch): Promise<AuthSession | null> {
    const row = await this.#db.one<Row>(sql`
      update x_sessions set
        last_seen_at = case when ${patch.lastSeenAt !== undefined}
          then ${patch.lastSeenAt ?? null} else last_seen_at end,
        ip = case when ${patch.ip !== undefined} then ${patch.ip ?? null} else ip end,
        user_agent = case when ${patch.userAgent !== undefined}
          then ${patch.userAgent ?? null} else user_agent end,
        mfa_satisfied = case when ${patch.mfaSatisfied !== undefined}
          then ${patch.mfaSatisfied ?? false} else mfa_satisfied end
      where id = ${id}
      returning *`);
    return row === null ? null : toSession(row);
  }

  async deleteSession(id: string): Promise<boolean> {
    return (await this.#db.execute(sql`delete from x_sessions where id = ${id}`)) > 0;
  }

  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    return await this.#db.execute(
      sql`delete from x_sessions where user_id = ${userId} and id <> ${keepSessionId}`,
    );
  }

  async listSessions(userId: string): Promise<readonly AuthSession[]> {
    const rows = await this.#db.query<Row>(
      sql`select * from x_sessions where user_id = ${userId} order by last_seen_at desc`,
    );
    return rows.map(toSession);
  }

  async linkAccount(account: AuthAccount): Promise<AuthAccount> {
    await this.#db.execute(sql`
      insert into x_accounts (id, user_id, provider, provider_account_id, access_token,
                              refresh_token, expires_at, created_at)
      values (${account.id}, ${account.userId}, ${account.provider}, ${account.providerAccountId},
              ${account.accessToken}, ${account.refreshToken}, ${account.expiresAt},
              ${account.createdAt})
      on conflict (provider, provider_account_id) do update
        set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at`);
    return account;
  }

  async findAccount(provider: string, providerAccountId: string): Promise<AuthAccount | null> {
    const row = await this.#db.one<Row>(sql`
      select * from x_accounts
      where provider = ${provider} and provider_account_id = ${providerAccountId}`);
    return row === null ? null : toAccount(row);
  }

  async listAccounts(userId: string): Promise<readonly AuthAccount[]> {
    const rows = await this.#db.query<Row>(sql`select * from x_accounts where user_id = ${userId}`);
    return rows.map(toAccount);
  }

  async putVerification(record: AuthVerification): Promise<void> {
    await this.#db.execute(sql`
      insert into x_verifications (id, purpose, identifier, token_hash, expires_at, created_at)
      values (${record.id}, ${record.purpose}, ${record.identifier}, ${record.tokenHash},
              ${record.expiresAt}, ${record.createdAt})
      on conflict (purpose, identifier) do update
        set id = excluded.id, token_hash = excluded.token_hash,
            expires_at = excluded.expires_at, created_at = excluded.created_at,
            consumed_at = null`);
  }

  /** The `consumed_at is null` predicate is what makes redemption single-use under concurrency. */
  async takeVerification(purpose: string, identifier: string): Promise<AuthVerification | null> {
    const row = await this.#db.one<Row>(sql`
      update x_verifications set consumed_at = now()
      where purpose = ${purpose} and identifier = ${identifier} and consumed_at is null
      returning *`);
    return row === null ? null : toVerification(row);
  }

  async putApiKey(record: AuthApiKeyRecord): Promise<AuthApiKeyRecord> {
    await this.#db.execute(sql`
      insert into x_api_keys (id, prefix, key_hash, user_id, org_id, scopes, expires_at, created_at)
      values (${record.id}, ${record.prefix}, ${record.keyHash}, ${record.userId},
              ${record.orgId}, ${[...record.scopes]}, ${record.expiresAt}, ${record.createdAt})`);
    return record;
  }

  async findApiKeyById(id: string): Promise<AuthApiKeyRecord | null> {
    const row = await this.#db.one<Row>(sql`select * from x_api_keys where id = ${id}`);
    return row === null ? null : toApiKey(row);
  }

  async listApiKeys(ownerId: string): Promise<readonly AuthApiKeyRecord[]> {
    const rows = await this.#db.query<Row>(sql`
      select * from x_api_keys where user_id = ${ownerId} or org_id = ${ownerId}
      order by created_at desc`);
    return rows.map(toApiKey);
  }

  async touchApiKey(id: string, at: Date): Promise<void> {
    await this.#db.execute(sql`update x_api_keys set last_used_at = ${at} where id = ${id}`);
  }

  async revokeApiKey(id: string, at: Date): Promise<boolean> {
    const changed = await this.#db.execute(
      sql`update x_api_keys set revoked_at = ${at} where id = ${id} and revoked_at is null`,
    );
    return changed > 0;
  }
}
