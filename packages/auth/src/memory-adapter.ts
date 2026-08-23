// Single responsibility: an in-memory `AuthAdapter`. It is the driver `x new` uses before a
// database exists and the one every test in this package runs against — the same interface
// Postgres and Better Auth implement, so a flow that works here works there or the seam is wrong.

import { type Clock, systemClock } from '@ultimat3/core';
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
  UserQuery,
} from './adapter';
import { authUniqueViolation } from './errors';
import { timingSafeEqual } from './tokens';

const verificationKey = (purpose: string, identifier: string): string => `${purpose}:${identifier}`;

export class MemoryAdapter implements AuthAdapter {
  readonly name = 'memory';
  readonly #clock: Clock;
  readonly #users = new Map<string, AuthUser>();
  readonly #sessions = new Map<string, AuthSession>();
  readonly #accounts = new Map<string, AuthAccount>();
  readonly #verifications = new Map<string, AuthVerification>();
  readonly #apiKeys = new Map<string, AuthApiKeyRecord>();

  /**
   * The clock every instant this adapter stamps comes from — one argument, because a stamp is a
   * fact about WHEN a call happened and a test that cannot move it can only assert a range.
   * Defaults to `systemClock`, so `new MemoryAdapter()` is what it always was.
   */
  constructor(clock: Clock = systemClock) {
    this.#clock = clock;
  }

  /**
   * Exact match, because `BuiltinAdapter` issues `where email = $1` against a plain `text ...
   * unique` column and nothing folds case there. Normalising here instead made this the ONE
   * adapter that found an account Postgres would not, which is a linked account under `x dev` and
   * a duplicate one in production. `normaliseEmail` is the caller's, above the seam.
   */
  async findUserByEmail(email: string): Promise<AuthUser | null> {
    for (const user of this.#users.values()) {
      if (user.email === email) return user;
    }
    return null;
  }

  async findUserById(id: string): Promise<AuthUser | null> {
    return this.#users.get(id) ?? null;
  }

  /**
   * The two UNIQUE constraints `x_users` declares, enforced here because `BuiltinAdapter` LEANS on
   * them: `email text not null unique` and `external_id text unique` (`tables.ts`). Without them
   * this adapter — the one `x new` scaffolds and every test runs against — accepted two rows at one
   * address, and the second was unreachable forever, since `findUserByEmail` returns the first.
   *
   * Over the STORED string, exactly as Postgres compares it. No case folding: that is the
   * divergence `adapter-parity.test.ts`'s first case pins, and `normaliseEmail` above the seam is
   * what makes two spellings one address.
   */
  async createUser(input: CreateUserInput): Promise<AuthUser> {
    for (const existing of this.#users.values()) {
      if (existing.email === input.email) {
        throw authUniqueViolation('createUser', 'x_users', 'email');
      }
      // `!= null` in one predicate, spelled out: a Postgres unique index is NULLS DISTINCT, so
      // `external_id text unique` constrains only the rows that CARRY a value and admits
      // unlimited NULLs. `!== undefined` alone made a second account with no external id collide
      // with the first — and `oauth-login.ts` hands over `grants.externalId ?? null` for every
      // first-time OAuth user, so the second such signup failed against a constraint production
      // does not have.
      if (
        input.externalId !== undefined &&
        input.externalId !== null &&
        existing.externalId === input.externalId
      ) {
        throw authUniqueViolation('createUser', 'x_users', 'external_id');
      }
    }
    const user: AuthUser = {
      id: input.id,
      // Stored as handed over, exactly as the `insert into x_users` binds it.
      email: input.email,
      emailVerifiedAt: null,
      passwordHash: input.passwordHash,
      orgId: input.orgId,
      roles: [...input.roles],
      permissions: [],
      scopes: [...(input.scopes ?? [])],
      mfaSecret: null,
      recoveryCodeHashes: [],
      externalId: input.externalId ?? null,
      disabledAt: null,
      createdAt: input.createdAt,
    };
    this.#users.set(user.id, user);
    return user;
  }

  async updateUser(id: string, patch: UserPatch): Promise<AuthUser | null> {
    const user = this.#users.get(id);
    if (user === undefined) return null;
    const next: AuthUser = {
      ...user,
      passwordHash: patch.passwordHash === undefined ? user.passwordHash : patch.passwordHash,
      emailVerifiedAt:
        patch.emailVerifiedAt === undefined ? user.emailVerifiedAt : patch.emailVerifiedAt,
      mfaSecret: patch.mfaSecret === undefined ? user.mfaSecret : patch.mfaSecret,
      recoveryCodeHashes: patch.recoveryCodeHashes ?? user.recoveryCodeHashes,
      disabledAt: patch.disabledAt === undefined ? user.disabledAt : patch.disabledAt,
      roles: patch.roles ?? user.roles,
      permissions: patch.permissions ?? user.permissions,
      scopes: patch.scopes ?? user.scopes,
      orgId: patch.orgId === undefined ? user.orgId : patch.orgId,
      externalId: patch.externalId === undefined ? user.externalId : patch.externalId,
    };
    this.#users.set(id, next);
    return next;
  }

  async findUserByExternalId(externalId: string): Promise<AuthUser | null> {
    for (const user of this.#users.values()) {
      if (user.externalId === externalId) return user;
    }
    return null;
  }

  async listUsersByOrg(orgId: string, query?: UserQuery): Promise<readonly AuthUser[]> {
    return [...this.#users.values()]
      .filter((user) => user.orgId === orgId)
      .filter((user) => query?.includeDisabled === true || user.disabledAt === null)
      .filter((user) => query?.role === undefined || user.roles.includes(query.role))
      .sort((a, b) => a.email.localeCompare(b.email));
  }

  async getSession(id: string): Promise<AuthSession | null> {
    return this.#sessions.get(id) ?? null;
  }

  async createSession(session: AuthSession): Promise<AuthSession> {
    this.#sessions.set(session.id, session);
    return session;
  }

  async updateSession(id: string, patch: SessionPatch): Promise<AuthSession | null> {
    const session = this.#sessions.get(id);
    if (session === undefined) return null;
    const next: AuthSession = {
      ...session,
      lastSeenAt: patch.lastSeenAt ?? session.lastSeenAt,
      ip: patch.ip === undefined ? session.ip : patch.ip,
      userAgent: patch.userAgent === undefined ? session.userAgent : patch.userAgent,
      mfaSatisfied: patch.mfaSatisfied ?? session.mfaSatisfied,
    };
    this.#sessions.set(id, next);
    return next;
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.#sessions.delete(id);
  }

  async deleteOtherSessions(userId: string, keepSessionId: string): Promise<number> {
    let killed = 0;
    for (const [id, session] of this.#sessions) {
      if (session.userId !== userId || id === keepSessionId) continue;
      this.#sessions.delete(id);
      killed += 1;
    }
    return killed;
  }

  async deleteSessionsForUser(userId: string): Promise<number> {
    return this.#deleteSessionsWhere((session) => session.userId === userId);
  }

  /** Joins through the user map, which is what the Postgres adapter's subselect does. */
  async deleteSessionsForOrg(orgId: string): Promise<number> {
    const members = new Set(
      [...this.#users.values()].filter((user) => user.orgId === orgId).map((user) => user.id),
    );
    return this.#deleteSessionsWhere((session) => members.has(session.userId));
  }

  async deleteSessionsCreatedBefore(before: Date): Promise<number> {
    return this.#deleteSessionsWhere((session) => session.createdAt.getTime() < before.getTime());
  }

  #deleteSessionsWhere(matches: (session: AuthSession) => boolean): number {
    let killed = 0;
    for (const [id, session] of this.#sessions) {
      if (!matches(session)) continue;
      this.#sessions.delete(id);
      killed += 1;
    }
    return killed;
  }

  async listSessions(userId: string): Promise<readonly AuthSession[]> {
    return [...this.#sessions.values()]
      .filter((session) => session.userId === userId)
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }

  async linkAccount(account: AuthAccount): Promise<AuthAccount> {
    this.#accounts.set(`${account.provider}:${account.providerAccountId}`, account);
    return account;
  }

  async findAccount(provider: string, providerAccountId: string): Promise<AuthAccount | null> {
    return this.#accounts.get(`${provider}:${providerAccountId}`) ?? null;
  }

  async listAccounts(userId: string): Promise<readonly AuthAccount[]> {
    return [...this.#accounts.values()].filter((account) => account.userId === userId);
  }

  async putVerification(record: AuthVerification): Promise<void> {
    this.#verifications.set(verificationKey(record.purpose, record.identifier), record);
  }

  async takeVerification(
    purpose: string,
    identifier: string,
    tokenHash: string,
  ): Promise<AuthVerification | null> {
    const key = verificationKey(purpose, identifier);
    const record = this.#verifications.get(key);
    if (record === undefined || record.consumedAt !== null) return null;
    // Before the write, never after: a wrong guess that consumed the row would be an
    // unauthenticated way to kill the victim's live link, which is the Postgres adapter's rule too.
    if (!timingSafeEqual(tokenHash, record.tokenHash)) return null;
    // The moment it was REDEEMED, which is what `consumed_at = now()` writes on the Postgres
    // side. This was `new Date(record.createdAt)` — the moment it was ISSUED — so every window
    // measured from the stamp read a redemption as having happened at issue time.
    const consumed: AuthVerification = { ...record, consumedAt: this.#clock.now() };
    this.#verifications.set(key, consumed);
    return consumed;
  }

  async putApiKey(record: AuthApiKeyRecord): Promise<AuthApiKeyRecord> {
    this.#apiKeys.set(record.id, record);
    return record;
  }

  async findApiKeyById(id: string): Promise<AuthApiKeyRecord | null> {
    return this.#apiKeys.get(id) ?? null;
  }

  async listApiKeys(ownerId: string): Promise<readonly AuthApiKeyRecord[]> {
    return [...this.#apiKeys.values()].filter(
      (key) => key.userId === ownerId || key.orgId === ownerId,
    );
  }

  async touchApiKey(id: string, at: Date): Promise<void> {
    const key = this.#apiKeys.get(id);
    if (key === undefined) return;
    this.#apiKeys.set(id, { ...key, lastUsedAt: at });
  }

  async revokeApiKey(id: string, at: Date): Promise<boolean> {
    const key = this.#apiKeys.get(id);
    if (key === undefined || key.revokedAt !== null) return false;
    this.#apiKeys.set(id, { ...key, revokedAt: at });
    return true;
  }
}
