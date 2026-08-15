// Single responsibility: the persistence seam. `AuthAdapter` is the one interface auth talks
// to, split into per-concern stores so a test (or a caller) can satisfy just the slice it uses.
// Better Auth binds here — it is an adapter implementation, not a dependency. The blessed
// default is `BuiltinAdapter` in `builtin-adapter.ts`; the DDL it expects is in `tables.ts`.

export interface AuthUser {
  readonly id: string;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  /** `null` for an OAuth-only account. Never a plaintext password. */
  readonly passwordHash: string | null;
  readonly orgId: string | null;
  /** Authz roles (`editor`), expanded to permissions by `@ultimat3/policy`. */
  readonly roles: readonly string[];
  /** Direct grants that bypass roles. Rare; used by break-glass accounts. */
  readonly permissions: readonly string[];
  /** Base32 TOTP secret, or `null` when MFA is not enrolled. */
  readonly mfaSecret: string | null;
  readonly recoveryCodeHashes: readonly string[];
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly orgId: string | null;
  readonly roles: readonly string[];
  readonly createdAt: Date;
}

export interface UserPatch {
  readonly passwordHash?: string | null | undefined;
  readonly emailVerifiedAt?: Date | null | undefined;
  readonly mfaSecret?: string | null | undefined;
  readonly recoveryCodeHashes?: readonly string[] | undefined;
  readonly disabledAt?: Date | null | undefined;
  readonly roles?: readonly string[] | undefined;
}

export interface UserStore {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  createUser(input: CreateUserInput): Promise<AuthUser>;
  updateUser(id: string, patch: UserPatch): Promise<AuthUser | null>;
}

export interface AuthSession {
  /** Public, non-secret lookup key. The secret half of the cookie never reaches the row. */
  readonly id: string;
  readonly userId: string;
  /** SHA-256 of the token secret. A DB dump is not a session-hijack kit. */
  readonly tokenHash: string;
  readonly createdAt: Date;
  /** Hard ceiling, never extended by activity. */
  readonly absoluteExpiresAt: Date;
  /** Moves on every request; `idleTtlMs` is measured from here. */
  readonly lastSeenAt: Date;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly mfaSatisfied: boolean;
}

export interface SessionPatch {
  readonly lastSeenAt?: Date | undefined;
  readonly ip?: string | null | undefined;
  readonly userAgent?: string | null | undefined;
  readonly mfaSatisfied?: boolean | undefined;
}

export interface SessionStore {
  getSession(id: string): Promise<AuthSession | null>;
  createSession(session: AuthSession): Promise<AuthSession>;
  updateSession(id: string, patch: SessionPatch): Promise<AuthSession | null>;
  deleteSession(id: string): Promise<boolean>;
  /** Returns how many were killed — the "sign out everywhere else" number shown to the user. */
  deleteOtherSessions(userId: string, keepSessionId: string): Promise<number>;
  listSessions(userId: string): Promise<readonly AuthSession[]>;
}

export interface AuthAccount {
  readonly id: string;
  readonly userId: string;
  readonly provider: string;
  readonly providerAccountId: string;
  readonly accessToken: string | null;
  readonly refreshToken: string | null;
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
}

export interface AccountStore {
  linkAccount(account: AuthAccount): Promise<AuthAccount>;
  findAccount(provider: string, providerAccountId: string): Promise<AuthAccount | null>;
  listAccounts(userId: string): Promise<readonly AuthAccount[]>;
}

export interface AuthVerification {
  readonly id: string;
  /** `email-verify` | `password-reset` — see `verify.ts`. */
  readonly purpose: string;
  /** The email address the token was issued for. */
  readonly identifier: string;
  readonly tokenHash: string;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
  readonly createdAt: Date;
}

export interface VerificationStore {
  /** Upsert on `(purpose, identifier)` — issuing a new token invalidates the previous one. */
  putVerification(record: AuthVerification): Promise<void>;
  /**
   * Read **and consume** in one atomic step, and only when `tokenHash` is the live row's.
   * Single-use is a storage guarantee, not a caller convention: two concurrent redemptions must
   * not both see an unconsumed row. The hash belongs to that same step for the same reason — a
   * store that consumes first and lets the caller compare afterwards lets an unauthenticated
   * wrong guess destroy the victim's live token, which is a password-reset denial of service
   * against any address an attacker can name. A non-match consumes nothing and answers `null`.
   */
  takeVerification(
    purpose: string,
    identifier: string,
    tokenHash: string,
  ): Promise<AuthVerification | null>;
}

export interface AuthApiKeyRecord {
  /** The non-secret half of the token; the lookup key. */
  readonly id: string;
  /** `ult_<env>_<id>` — safe to display, safe to log. */
  readonly prefix: string;
  readonly keyHash: string;
  readonly userId: string | null;
  readonly orgId: string | null;
  /** Exactly the scopes the agent actor gets. Never widened at resolve time. */
  readonly scopes: readonly string[];
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export interface ApiKeyStore {
  putApiKey(record: AuthApiKeyRecord): Promise<AuthApiKeyRecord>;
  findApiKeyById(id: string): Promise<AuthApiKeyRecord | null>;
  listApiKeys(ownerId: string): Promise<readonly AuthApiKeyRecord[]>;
  touchApiKey(id: string, at: Date): Promise<void>;
  revokeApiKey(id: string, at: Date): Promise<boolean>;
}

/**
 * The full seam. One blessed implementation ships (`BuiltinAdapter`); Better Auth, or any
 * other identity backend, binds by implementing this and nothing else changes upstream.
 */
export interface AuthAdapter
  extends UserStore,
    SessionStore,
    AccountStore,
    VerificationStore,
    ApiKeyStore {
  /** Shown by `x auth doctor --json` so the driver in use is never a guess. */
  readonly name: string;
}
