// Single responsibility: an in-memory `AuthAdapter`. It is the driver `x new` uses before a
// database exists and the one every test in this package runs against — the same interface
// Postgres and Better Auth implement, so a flow that works here works there or the seam is wrong.

import { type Clock, systemClock, timingSafeEqual } from '@ultimat3/core';
import type {
  AuthAccount,
  AuthAdapter,
  AuthApiKeyRecord,
  AuthSession,
  AuthUser,
  AuthVerification,
  CreateUserInput,
  SessionPatch,
  StoredMfaSecret,
  UserPatch,
  UserQuery,
} from './adapter';
import { authUniqueViolation } from './errors';

const verificationKey = (purpose: string, identifier: string): string => `${purpose}:${identifier}`;

/**
 * `BuiltinAdapter`'s `order by email collate "C"`: byte order over UTF-8, which is CODE-POINT order
 * — never `localeCompare` (the machine's locale) and never `<` on strings, whose UTF-16 code units
 * put an astral character (a lead surrogate, 0xD8xx) ahead of U+E000–U+FFFF.
 */
const byCodePoint = (a: string, b: string): number => {
  const left = a[Symbol.iterator]();
  const right = b[Symbol.iterator]();
  for (;;) {
    const x = left.next();
    const y = right.next();
    if (x.done === true || y.done === true)
      return (x.done === true ? 0 : 1) - (y.done === true ? 0 : 1);
    const delta = (x.value.codePointAt(0) ?? 0) - (y.value.codePointAt(0) ?? 0);
    if (delta !== 0) return delta;
  }
};

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
   * Defaults to `systemClock`, so `memoryAuthAdapter()` is what it always was.
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
    // `id uuid primary key`: a `Map.set` over an existing id REPLACED the first account.
    if (this.#users.has(input.id)) throw authUniqueViolation('createUser', 'x_users', 'id');
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
    // `external_id text unique`, on the UPDATE as on the INSERT: every OTHER row, and only a
    // value — NULLS DISTINCT, so clearing it never collides. `UserPatch` carries no `email`.
    if (patch.externalId !== undefined && patch.externalId !== null) {
      for (const other of this.#users.values()) {
        if (other.id !== id && other.externalId === patch.externalId) {
          throw authUniqueViolation('updateUser', 'x_users', 'external_id');
        }
      }
    }
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

  async listUsersWithMfaSecret(): Promise<readonly StoredMfaSecret[]> {
    const stored: StoredMfaSecret[] = [];
    for (const user of this.#users.values()) {
      if (user.mfaSecret !== null) stored.push({ userId: user.id, mfaSecret: user.mfaSecret });
    }
    return stored.sort((a, b) => (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0));
  }

  // No `await` between the check and the write: the two are one step, as the UPDATE is.
  async replaceMfaSecret(userId: string, expected: string, next: string): Promise<boolean> {
    const user = this.#users.get(userId);
    if (user === undefined || user.mfaSecret === null) return false;
    if (!timingSafeEqual(user.mfaSecret, expected)) return false;
    this.#users.set(userId, { ...user, mfaSecret: next });
    return true;
  }

  // No `await` between the check and the write: the two are one step, as the UPDATE is.
  async consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean> {
    const user = this.#users.get(userId);
    const held = (stored: string): boolean => timingSafeEqual(stored, codeHash);
    if (user === undefined || !user.recoveryCodeHashes.some(held)) return false;
    this.#users.set(userId, {
      ...user,
      recoveryCodeHashes: user.recoveryCodeHashes.filter((stored) => !held(stored)),
    });
    return true;
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
      .sort((a, b) => byCodePoint(a.email, b.email));
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

  /** Postgres's `on conflict … do update`: the owner, id and created_at stay; the tokens move. */
  async linkAccount(account: AuthAccount): Promise<AuthAccount> {
    const key = `${account.provider}:${account.providerAccountId}`;
    const existing = this.#accounts.get(key);
    const stored =
      existing === undefined
        ? account
        : {
            ...existing,
            accessToken: account.accessToken,
            refreshToken: account.refreshToken,
            expiresAt: account.expiresAt,
          };
    this.#accounts.set(key, stored);
    return stored;
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
    // `order by created_at desc, id desc`, the builtin adapter's statement.
    return [...this.#apiKeys.values()]
      .filter((key) => key.userId === ownerId || key.orgId === ownerId)
      .sort(
        (a, b) =>
          b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
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

/**
 * The one way to build the in-memory adapter — the twin of `postgresAuthAdapter()`. The class is a
 * type in the barrel only (`X_FACTORY_NAME_SPELLING`), so `new` is never a second spelling.
 */
export function memoryAuthAdapter(clock: Clock = systemClock): MemoryAdapter {
  return new MemoryAdapter(clock);
}
