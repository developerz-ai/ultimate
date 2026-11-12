// Single responsibility: the one blessed `AuthAdapter`, backed by Postgres through
// `@ultimat3/db`. The `DbClient` is injected (defaulting to `db()`) so tests and the CLI can
// drive it without a database. Rows arrive as `unknown` and are read through the small typed
// readers in `builtin-adapter-rows.ts` — no `any`, and a renamed column fails a round trip.

import { type Clock, systemClock } from '@ultimat3/core';
import { type DbClient, db, sql } from '@ultimat3/db';
import type {
  AuthAccount,
  AuthAdapter,
  AuthApiKeyRecord,
  AuthSession,
  AuthUser,
  AuthVerification,
  CreateUserInput,
  PasskeyStore,
  SessionPatch,
  SessionWithUser,
  StoredMfaSecret,
  UserPatch,
  UserQuery,
} from './adapter';
import {
  type Row,
  text,
  toAccount,
  toApiKey,
  toSession,
  toUser,
  toVerification,
  unprefixed,
} from './builtin-adapter-rows';
import { usersUniqueViolation } from './builtin-adapter-violation';
import { authWriteFailed } from './errors';
import { postgresPasskeyStore } from './passkey-postgres';

/**
 * A patch column is written as `case when <set> then <value> else <column> end` rather than
 * assembled into dynamic SQL: `null` stays a meaningful value ("clear this field") and the
 * statement text remains constant, so the query plan is cached and nothing is interpolated.
 */
export class PostgresAuthAdapter implements AuthAdapter {
  readonly name = 'builtin-postgres';
  readonly #client: DbClient | undefined;
  readonly #clock: Clock;
  readonly #passkeys: PasskeyStore = postgresPasskeyStore(() => this.#db);
  // The passkey members are `passkey-postgres.ts`'s, bound once: closures over the store, no `this`.
  readonly putPasskey: PasskeyStore['putPasskey'] = this.#passkeys.putPasskey;
  readonly findPasskey: PasskeyStore['findPasskey'] = this.#passkeys.findPasskey;
  readonly listPasskeys: PasskeyStore['listPasskeys'] = this.#passkeys.listPasskeys;
  readonly advancePasskeyCounter: PasskeyStore['advancePasskeyCounter'] =
    this.#passkeys.advancePasskeyCounter;
  readonly deletePasskey: PasskeyStore['deletePasskey'] = this.#passkeys.deletePasskey;
  readonly putPasskeyChallenge: PasskeyStore['putPasskeyChallenge'] =
    this.#passkeys.putPasskeyChallenge;
  readonly takePasskeyChallenge: PasskeyStore['takePasskeyChallenge'] =
    this.#passkeys.takePasskeyChallenge;
  readonly putPasskeyEvidence: PasskeyStore['putPasskeyEvidence'] =
    this.#passkeys.putPasskeyEvidence;
  readonly listPasskeyEvidence: PasskeyStore['listPasskeyEvidence'] =
    this.#passkeys.listPasskeyEvidence;

  /**
   * `client` omitted, every call resolves the ambient `db()` when it runs, never once here: a
   * memoized `appAuth` is built by the process's first caller, and a client captured then
   * ignored every later `setDbClient` and every open `withTransaction`. Passed, it is pinned.
   * `clock` is the one `MemoryAuthAdapter` takes, for the same stamp: hand over the clock
   * `defineAuth` was given, so a redemption is dated by the clock that judged its expiry.
   */
  constructor(client?: DbClient, clock: Clock = systemClock) {
    this.#client = client;
    this.#clock = clock;
  }

  get #db(): DbClient {
    return this.#client ?? db();
  }

  /** A write to `x_users`, with the table's own unique violations answered as this package's. */
  async #writeUser(operation: string, statement: Parameters<DbClient['one']>[0]) {
    try {
      return await this.#db.one<Row>(statement);
    } catch (error) {
      throw usersUniqueViolation(operation, error) ?? error;
    }
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
    const row = await this.#writeUser(
      'createUser',
      sql`
      insert into x_users (id, email, password_hash, org_id, roles, scopes, external_id,
                           created_at)
      values (${input.id}, ${input.email}, ${input.passwordHash}, ${input.orgId},
              ${[...input.roles]}, ${[...(input.scopes ?? [])]}, ${input.externalId ?? null},
              ${input.createdAt})
      returning *`,
    );
    // An empty `returning` means no row landed. A user fabricated from `{}` would travel back
    // out of `register()` as a successful registration with no identity in it.
    if (row === null) throw authWriteFailed('createUser', 'x_users');
    return toUser(row);
  }

  async updateUser(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const row = await this.#writeUser(
      'updateUser',
      sql`
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
          then ${[...(patch.roles ?? [])]} else roles end,
        permissions = case when ${patch.permissions !== undefined}
          then ${[...(patch.permissions ?? [])]} else permissions end,
        scopes = case when ${patch.scopes !== undefined}
          then ${[...(patch.scopes ?? [])]} else scopes end,
        org_id = case when ${patch.orgId !== undefined}
          then ${patch.orgId ?? null} else org_id end,
        external_id = case when ${patch.externalId !== undefined}
          then ${patch.externalId ?? null} else external_id end
      where id = ${id}
      returning *`,
    );
    return row === null ? null : toUser(row);
  }

  async listUsersWithMfaSecret(): Promise<readonly StoredMfaSecret[]> {
    const rows = await this.#db.query<Row>(
      sql`select id, mfa_secret from x_users where mfa_secret is not null order by id`,
    );
    return rows.map((row) => ({ userId: text(row, 'id'), mfaSecret: text(row, 'mfa_secret') }));
  }

  async replaceMfaSecret(userId: string, expected: string, next: string): Promise<boolean> {
    const row = await this.#db.one<Row>(sql`
      update x_users set mfa_secret = ${next}
       where id = ${userId} and mfa_secret = ${expected}
      returning id`);
    return row !== null;
  }

  /**
   * One conditional UPDATE: the row is locked, and the `where` is re-checked against the version
   * a concurrent redemption just committed, so the second of two finds the hash already gone.
   */
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const row = await this.#db.one<Row>(sql`
      update x_users
         set recovery_code_hashes = array_remove(recovery_code_hashes, ${codeHash})
       where id = ${userId} and ${codeHash} = any(recovery_code_hashes)
      returning id`);
    return row !== null;
  }

  async findUserByExternalId(externalId: string): Promise<AuthUser | null> {
    const row = await this.#db.one<Row>(
      sql`select * from x_users where external_id = ${externalId}`,
    );
    return row === null ? null : toUser(row);
  }

  /**
   * One statement, and the two filters are conditional predicates rather than assembled SQL, for
   * the reason `updateUser`'s columns are: the statement text stays constant and nothing is
   * interpolated. Disabled members are excluded by default — an access review reads who can sign
   * in today — and `includeDisabled` is what an offboarding audit passes. Ordered `collate "C"`
   * (byte order, which `MemoryAuthAdapter` restates): the database default collation is the
   * cluster's locale, so the order changed with the deployment and disagreed with memory's.
   */
  async listUsersByOrg(orgId: string, query?: UserQuery): Promise<readonly AuthUser[]> {
    const role = query?.role ?? null;
    const rows = await this.#db.query<Row>(sql`
      select * from x_users
      where org_id = ${orgId}
        and (${query?.includeDisabled === true} or disabled_at is null)
        and (${role === null} or ${role} = any (roles))
      order by email collate "C" asc`);
    return rows.map(toUser);
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

  async deleteSessionsForUser(userId: string): Promise<number> {
    return await this.#db.execute(sql`delete from x_sessions where user_id = ${userId}`);
  }

  /**
   * Joins through `x_users` rather than reading an `org_id` off the session. The column does not
   * exist on `x_sessions` and is not being added: a copy of the membership goes stale the moment
   * somebody changes org, and a stale row means the 03:00 sweep leaves live exactly the sessions
   * it was run to kill.
   */
  async deleteSessionsForOrg(orgId: string): Promise<number> {
    return await this.#db.execute(sql`
      delete from x_sessions
      where user_id in (select id from x_users where org_id = ${orgId})`);
  }

  /**
   * The session's columns aliased `s_*`, because both tables have an `id` and a `created_at`; the
   * user's arrive under their own names. A left join, so a session that outlived its user still
   * comes back — `authenticate` deletes it, exactly as it does after the two-read path.
   */
  async getSessionWithUser(id: string): Promise<SessionWithUser | null> {
    const row = await this.#db.one<Row>(sql`
      select s.id as s_id, s.user_id as s_user_id, s.token_hash as s_token_hash,
             s.created_at as s_created_at, s.absolute_expires_at as s_absolute_expires_at,
             s.last_seen_at as s_last_seen_at, s.ip as s_ip, s.user_agent as s_user_agent,
             s.mfa_satisfied as s_mfa_satisfied, u.*
        from x_sessions s left join x_users u on u.id = s.user_id
       where s.id = ${id}`);
    if (row === null) return null;
    return {
      session: toSession(unprefixed(row, 's_')),
      user: row['id'] === null || row['id'] === undefined ? null : toUser(row),
    };
  }

  async deleteSessionsCreatedBefore(before: Date): Promise<number> {
    return await this.#db.execute(sql`delete from x_sessions where created_at < ${before}`);
  }

  async listSessions(userId: string): Promise<readonly AuthSession[]> {
    const rows = await this.#db.query<Row>(
      sql`select * from x_sessions where user_id = ${userId} order by last_seen_at desc`,
    );
    return rows.map(toSession);
  }

  /**
   * On a pair that is already linked the row keeps its `id`, `user_id` and `created_at` and only
   * the tokens move — so the answer is the row `returning *` reports, never the object handed in,
   * which named a user the row does not belong to.
   */
  async linkAccount(account: AuthAccount): Promise<AuthAccount> {
    const row = await this.#db.one<Row>(sql`
      insert into x_accounts (id, user_id, provider, provider_account_id, access_token,
                              refresh_token, expires_at, created_at)
      values (${account.id}, ${account.userId}, ${account.provider}, ${account.providerAccountId},
              ${account.accessToken}, ${account.refreshToken}, ${account.expiresAt},
              ${account.createdAt})
      on conflict (provider, provider_account_id) do update
        set access_token = excluded.access_token, refresh_token = excluded.refresh_token,
            expires_at = excluded.expires_at
      returning *`);
    return row === null ? account : toAccount(row);
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

  /**
   * `consumed_at` is the injected clock's instant, bound — never the server's `now()`, which made
   * the stamp the one instant in this package no test could move and no `Clock` agreed with.
   *
   * One conditional UPDATE, and every part of the predicate is load-bearing. `consumed_at is null`
   * on the UPDATE itself is what makes redemption single-use under concurrency — inside the
   * subselect alone, two racing redemptions both pick the row and both consume it. `token_hash`
   * is what keeps a wrong guess from consuming anything: a consume that happens before the
   * comparison turns any unauthenticated POST into a way to kill the victim's emailed link. The
   * predicate compares the digest and never the token, so it leaks what a `=` on a hash leaks.
   * `order by created_at desc limit 1` addresses exactly one row: `unique (purpose, identifier)`
   * (`tables.ts`) already allows only one, but an unbounded `update … where` consumes every row
   * that matches, so a table missing that constraint would redeem links nobody presented.
   */
  async takeVerification(
    purpose: string,
    identifier: string,
    tokenHash: string,
  ): Promise<AuthVerification | null> {
    const row = await this.#db.one<Row>(sql`
      update x_verifications set consumed_at = ${this.#clock.now()}
      where consumed_at is null and id = (
        select id from x_verifications
        where purpose = ${purpose} and identifier = ${identifier}
          and consumed_at is null and token_hash = ${tokenHash}
        order by created_at desc
        limit 1
      )
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
      order by created_at desc, id desc`);
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

/**
 * The one way to build the Postgres adapter — the twin of `memoryAuthAdapter()`. The class is a
 * type in the barrel only (`X_FACTORY_NAME_SPELLING`), so `new` is never a second spelling. No
 * `client`: each call reads the ambient `db()` as it runs, so build it once and keep it.
 */
export function postgresAuthAdapter(
  client?: DbClient,
  clock: Clock = systemClock,
): PostgresAuthAdapter {
  return new PostgresAuthAdapter(client, clock);
}
