// Single responsibility: the persistence seam. `AuthAdapter` is the one interface auth talks
// to, split into per-concern stores so a test (or a caller) can satisfy just the slice it uses.
// Better Auth binds here — it is an adapter implementation, not a dependency. The blessed
// default is `PostgresAuthAdapter` in `builtin-adapter.ts`; the DDL it expects is in `tables.ts`.

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
  /**
   * The TOTP secret AS STORED — sealed (`mfa-secret.ts`), never base32 — or `null` when MFA is
   * not enrolled. Only `openTotpSecret` turns it into something a code can be checked against.
   */
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
   * Required, like every member of the seam: an adapter that lacks one is a compile error at the
   * `defineAuth({ adapter })` it is handed to, never an `X_NOT_IMPLEMENTED` at the first SCIM
   * lookup in production. Exact match on the stored string, `null` when nobody carries it.
   */
  findUserByExternalId(externalId: string): Promise<AuthUser | null>;
  /**
   * Enumeration — a quarterly access review needs it. Ordered by email ascending; disabled members
   * are left out unless `query.includeDisabled` is `true`.
   */
  listUsersByOrg(orgId: string, query?: UserQuery): Promise<readonly AuthUser[]>;
  /**
   * Every user holding a second-factor secret, with the value exactly as stored, ordered by id.
   * The one enumeration `sealMfaSecrets` needs: it cannot seal what it cannot find, and whether a
   * stored value is sealed is core's `isSealed` to say — never a `like` in an adapter.
   */
  listUsersWithMfaSecret(): Promise<readonly StoredMfaSecret[]>;
  /**
   * Compare-and-set on one user's stored secret: write `next` only while the row still holds
   * `expected`, in ONE atomic step, and answer whether it did. What `sealMfaSecrets` writes
   * through — a user who re-enrolled since the value was read must keep the NEW secret, and a
   * plain write would put the old one back, sealed.
   */
  replaceMfaSecret(userId: string, expected: string, next: string): Promise<boolean>;
  /**
   * Remove one recovery-code hash from one user, and answer whether it was there — in ONE atomic
   * step. Single-use is a storage guarantee, exactly as `takeVerification`'s is: two concurrent
   * redemptions of one code must not both find it, which a read followed by a write lets happen.
   */
  consumeRecoveryCode(userId: string, codeHash: string): Promise<boolean>;
}

export interface StoredMfaSecret {
  readonly userId: string;
  readonly mfaSecret: string;
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
  /**
   * Remove one session and answer whether THIS call removed it, in one atomic step: `rotateSession`
   * treats `true` as its claim on the id, so two concurrent deletes must not both answer `true`.
   */
  deleteSession(id: string): Promise<boolean>;
  /** Returns how many were killed — the "sign out everywhere else" number shown to the user. */
  deleteOtherSessions(userId: string, keepSessionId: string): Promise<number>;
  listSessions(userId: string): Promise<readonly AuthSession[]>;
  /**
   * Every session this user holds, including the caller's own. `deleteOtherSessions` cannot
   * express it — there is no session id to keep — and a password change or a disable has to.
   * Returns how many were killed.
   */
  deleteSessionsForUser(userId: string): Promise<number>;
  /**
   * Everything issued before an instant. The credential-compromise sweep: rotate the secret,
   * then kill everything minted under the old one, without enumerating users. Strictly before:
   * a session created AT the instant survives.
   */
  deleteSessionsCreatedBefore(before: Date): Promise<number>;
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
  /** A declared purpose's name — `email-verify`, `password-reset` or any `defineVerificationPurpose`. */
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

/** Which ceremony a stored challenge was issued for; a challenge redeems only for its own. */
export type PasskeyCeremony = 'register' | 'login' | 'step-up';

/**
 * One registered passkey. Every byte field is base64url TEXT, so both adapters store and compare
 * the same string and a row is readable in a SQL console.
 */
export interface PasskeyCredential {
  /** The credential id the authenticator minted — globally unique, the lookup key. */
  readonly id: string;
  readonly userId: string;
  /** The COSE_Key exactly as registered; `importCoseKey` turns it back into a verifying key. */
  readonly publicKey: string;
  /** COSE algorithm: `-7` (ES256) or `-257` (RS256). */
  readonly algorithm: number;
  /** The last signature counter seen. `0` forever for an authenticator that keeps none. */
  readonly signCount: number;
  readonly transports: readonly string[];
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}

/** An issued, not yet redeemed ceremony challenge. Never the challenge itself: its digest. */
export interface PasskeyChallengeRecord {
  /** `sha256Hex` of the base64url challenge — what `clientDataJSON` echoes, hashed. */
  readonly id: string;
  readonly ceremony: PasskeyCeremony;
  /** The user it was issued to; `null` for a usernameless sign-in. */
  readonly userId: string | null;
  /** Step-up only: the server digest and the nonce the challenge was derived from, base64url. */
  readonly digest: string | null;
  readonly nonce: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

/**
 * A verified step-up assertion, kept whole: everything `verifyPasskeyEvidence` needs to check it
 * again later, in another process, with no other row — the key included, so deleting the passkey
 * does not un-prove what it approved.
 */
export interface PasskeyEvidence {
  readonly id: string;
  readonly userId: string;
  readonly credentialId: string;
  /** The bytes the person approved, base64url. */
  readonly digest: string;
  readonly nonce: string;
  readonly authenticatorData: string;
  readonly clientDataJSON: string;
  readonly signature: string;
  readonly publicKey: string;
  readonly algorithm: number;
  readonly createdAt: Date;
}

export interface PasskeyStore {
  /** A credential id already stored — any user's — is `X_AUTH_WRITE_FAILED` (§7.1 step 22). */
  putPasskey(credential: PasskeyCredential): Promise<PasskeyCredential>;
  findPasskey(id: string): Promise<PasskeyCredential | null>;
  /** Oldest first. */
  listPasskeys(userId: string): Promise<readonly PasskeyCredential[]>;
  /**
   * Compare-and-set on the counter: write `next` (and `at` as last use) only while the row still
   * holds `expected`, in ONE atomic step. Two assertions racing on one counter value must not
   * both advance it — that is the cloned-authenticator signal.
   */
  advancePasskeyCounter(id: string, expected: number, next: number, at: Date): Promise<boolean>;
  /** Scoped to the owner: one user cannot delete another's passkey by naming its id. */
  deletePasskey(userId: string, id: string): Promise<boolean>;
  /** Also drops every challenge that expired before `record.createdAt`, so the table stays bounded. */
  putPasskeyChallenge(record: PasskeyChallengeRecord): Promise<void>;
  /**
   * Read AND delete in one atomic step, only for its own ceremony: two concurrent redemptions of
   * one challenge must not both find it. Expiry is the caller's to judge, on its clock.
   */
  takePasskeyChallenge(
    id: string,
    ceremony: PasskeyCeremony,
  ): Promise<PasskeyChallengeRecord | null>;
  putPasskeyEvidence(evidence: PasskeyEvidence): Promise<void>;
  /** Every stored approval of one digest, oldest first. */
  listPasskeyEvidence(digest: string): Promise<readonly PasskeyEvidence[]>;
}

/**
 * The full seam. One blessed implementation ships (`PostgresAuthAdapter`); Better Auth, or any
 * other identity backend, binds by implementing this and nothing else changes upstream.
 */
export interface AuthAdapter
  extends UserStore,
    SessionStore,
    AccountStore,
    VerificationStore,
    ApiKeyStore,
    PasskeyStore {
  /** Reported by `Auth.adapter.name` so the driver in use is never a guess. */
  readonly name: string;
  /**
   * Every session held by every member of one org. It spans two tables — `x_sessions` carries no
   * `org_id` and deliberately does not gain one, because org membership lives on the user and a
   * denormalised copy goes stale the moment somebody moves org, which makes the 03:00 sweep miss
   * exactly the sessions it was run for. So it joins through `x_users`, which is why it sits on
   * the full adapter rather than on `SessionStore`.
   */
  deleteSessionsForOrg(orgId: string): Promise<number>;
  /**
   * One session and the user it belongs to, in ONE read — what `authenticate` runs on every
   * request, where `getSession` then `findUserById` is two sequential round trips. `null` when
   * the session is unknown; `user: null` when the session outlived its user. The user row is read
   * fresh by every call, never cached: a disable must refuse the very next request.
   *
   * Optional, unlike the rest of the seam: absent, `authenticate` makes the two reads it replaces,
   * so an adapter written before it still binds. `authAdapterConformance` holds one that has it to
   * answering exactly what those two reads answer. Spans two tables, so it sits here, beside the
   * org sweep, rather than on `SessionStore`.
   */
  getSessionWithUser?(id: string): Promise<SessionWithUser | null>;
}

/** What `getSessionWithUser` answers for a session that exists. */
export interface SessionWithUser {
  readonly session: AuthSession;
  readonly user: AuthUser | null;
}
