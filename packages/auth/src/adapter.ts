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
  /**
   * Capability strings this human may hold, landing on `Actor.scopes` — the field `hasScope()`
   * reads and `permissions` is not. Without it a user actor's scopes were the hardcoded `[]`, so
   * a scope-gated human surface (`tenancy:cross`, and every support tool built on one) was
   * unreachable by any human and could only be reached by minting a `serviceActor`, which throws
   * the operator's identity away. Empty for almost every account.
   */
  readonly scopes: readonly string[];
  /** Base32 TOTP secret, or `null` when MFA is not enrolled. */
  readonly mfaSecret: string | null;
  readonly recoveryCodeHashes: readonly string[];
  /**
   * The identifier the IdP knows this person by — SCIM's `externalId`, OIDC's `sub`. Stable
   * across a rename and across an address change, which is what a provisioning PUT/PATCH lands
   * on and what an email address cannot be. `null` for an account that arrived by password.
   */
  readonly externalId: string | null;
  readonly disabledAt: Date | null;
  readonly createdAt: Date;
}

export interface CreateUserInput {
  readonly id: string;
  readonly email: string;
  readonly passwordHash: string | null;
  readonly orgId: string | null;
  readonly roles: readonly string[];
  readonly scopes?: readonly string[] | undefined;
  readonly externalId?: string | null | undefined;
  readonly createdAt: Date;
}

export interface UserPatch {
  readonly passwordHash?: string | null | undefined;
  readonly emailVerifiedAt?: Date | null | undefined;
  readonly mfaSecret?: string | null | undefined;
  readonly recoveryCodeHashes?: readonly string[] | undefined;
  readonly disabledAt?: Date | null | undefined;
  readonly roles?: readonly string[] | undefined;
  readonly permissions?: readonly string[] | undefined;
  readonly scopes?: readonly string[] | undefined;
  readonly orgId?: string | null | undefined;
  readonly externalId?: string | null | undefined;
}

/** What `listUsersByOrg` filters on. Absent means every member of the org. */
export interface UserQuery {
  readonly role?: string | undefined;
  readonly includeDisabled?: boolean | undefined;
}

export interface UserStore {
  findUserByEmail(email: string): Promise<AuthUser | null>;
  findUserById(id: string): Promise<AuthUser | null>;
  createUser(input: CreateUserInput): Promise<AuthUser>;
  updateUser(id: string, patch: UserPatch): Promise<AuthUser | null>;
  /**
   * Optional so an adapter written against 1.2's seam still compiles; both shipped adapters
   * implement it, and `directory.ts` answers `X_NOT_IMPLEMENTED` with the method name when one
   * does not. The alternative was a required member, which is a breaking change to every
   * third-party `AuthAdapter` for a capability most of them will never be asked for.
   */
  findUserByExternalId?(externalId: string): Promise<AuthUser | null>;
  /** Enumeration, which nothing in the seam could do — a quarterly access review needs it. */
  listUsersByOrg?(orgId: string, query?: UserQuery): Promise<readonly AuthUser[]>;
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
  /**
   * Every session this user holds, including the caller's own. `deleteOtherSessions` cannot
   * express it — there is no session id to keep — and a password change or a disable has to.
   *
   * Optional for the reason `findUserByExternalId` is: adding a required member to a shipped
   * seam breaks every third-party adapter. `revocation.ts` refuses with `X_NOT_IMPLEMENTED` and
   * names the method when an adapter has not got it.
   */
  deleteSessionsForUser?(userId: string): Promise<number>;
  /**
   * Everything issued before an instant. The credential-compromise sweep: rotate the secret,
   * then kill everything minted under the old one, without enumerating users.
   */
  deleteSessionsCreatedBefore?(before: Date): Promise<number>;
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
  /** Reported by `Auth.adapter.name` so the driver in use is never a guess. */
  readonly name: string;
  /**
   * Every session held by every member of one org. It spans two tables — `x_sessions` carries no
   * `org_id` and deliberately does not gain one, because org membership lives on the user and a
   * denormalised copy goes stale the moment somebody moves org, which makes the 03:00 sweep miss
   * exactly the sessions it was run for. So it joins through `x_users`, which is why it sits on
   * the full adapter rather than on `SessionStore`.
   */
  deleteSessionsForOrg?(orgId: string): Promise<number>;
}
