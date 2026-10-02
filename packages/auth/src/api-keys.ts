// Single responsibility: machine credentials. This is how an agent — an MCP client driving a
// generated Ultimate app — authenticates: it presents a key, the key resolves to an
// `agentActor` carrying exactly the key's scopes, and it goes through the same policy
// evaluation a human does. The plaintext is shown once; only its SHA-256 is ever stored, and
// lookup happens by the non-secret id so the secret never appears in a query, an index or a log.

import { type Clock, randomHex, systemClock } from '@ultimat3/core';
import type { ApiKeyStore, AuthApiKeyRecord, AuthUser, UserStore } from './adapter';
import { apiKeyEnvInvalid, apiKeyInvalid, apiKeyScopeWildcard } from './errors';
import type { PolicyActor } from './policy-bridge';
import { actorFromApiKey, isWildcardScope } from './policy-bridge';
import { randomToken, sha256Hex, timingSafeEqual } from './tokens';

export const API_KEY_NAMESPACE = 'ult';

/** `ult_<env>_<id>_<secret>` — the first three segments are the displayable prefix. */
export const API_KEY_PREFIX_SEGMENTS = 3;

export interface ParsedApiKey {
  readonly env: string;
  readonly id: string;
  readonly prefix: string;
  readonly secret: string;
}

export function apiKeyPrefix(env: string, id: string): string {
  return `${API_KEY_NAMESPACE}_${env}_${id}`;
}

/**
 * Split on `_` with a limit: the secret is base64url and may itself contain `_`, so the tail
 * is rejoined rather than assumed to be a single segment.
 */
export function parseApiKey(plaintext: string): ParsedApiKey | null {
  const parts = plaintext.split('_');
  if (parts.length <= API_KEY_PREFIX_SEGMENTS) return null;
  const [namespace, env, id] = parts;
  if (namespace !== API_KEY_NAMESPACE || env === undefined || id === undefined) return null;
  if (env.length === 0 || id.length === 0) return null;
  const secret = parts.slice(API_KEY_PREFIX_SEGMENTS).join('_');
  if (secret.length === 0) return null;
  return { env, id, prefix: apiKeyPrefix(env, id), secret };
}

export interface IssueApiKeyInput {
  /** `dev` | `stage` | `prod` — visible in the token so a leaked key is triageable at a glance. */
  readonly env: string;
  readonly scopes: readonly string[];
  readonly userId?: string | null | undefined;
  readonly orgId?: string | null | undefined;
  readonly expiresAt?: Date | null | undefined;
  readonly clock?: Clock | undefined;
}

export interface IssuedApiKey {
  /** Shown once. Nothing in `record` can reproduce it. */
  readonly plaintext: string;
  readonly record: AuthApiKeyRecord;
}

/** What `parseApiKey` can split back out: no `_`, and nothing a log would render two ways. */
const API_KEY_ENV = /^[a-z0-9-]+$/;

export function issueApiKey(input: IssueApiKeyInput): IssuedApiKey {
  if (!API_KEY_ENV.test(input.env)) throw apiKeyEnvInvalid(input.env);
  const wildcard = input.scopes.find(isWildcardScope);
  if (wildcard !== undefined) throw apiKeyScopeWildcard(wildcard);
  const clock = input.clock ?? systemClock;
  // Hex, not base64url: the id sits between two `_` delimiters and must not contain one.
  const id = randomHex(8);
  const secret = randomToken(32);
  const plaintext = `${apiKeyPrefix(input.env, id)}_${secret}`;
  return {
    plaintext,
    record: {
      id,
      prefix: apiKeyPrefix(input.env, id),
      keyHash: sha256Hex(secret),
      userId: input.userId ?? null,
      orgId: input.orgId ?? null,
      scopes: [...input.scopes],
      lastUsedAt: null,
      expiresAt: input.expiresAt ?? null,
      revokedAt: null,
      createdAt: clock.now(),
    },
  };
}

/** What verification reads: the key, and the user row of whoever owns it. */
export type ApiKeyVerifyStore = ApiKeyStore & Pick<UserStore, 'findUserById'>;

export interface VerifiedApiKey {
  readonly record: AuthApiKeyRecord;
  /** The user the key was issued to, as the row reads NOW. `null` for a key no user owns. */
  readonly owner: AuthUser | null;
}

/**
 * Every rejection — malformed, unknown, revoked, expired, wrong secret, an owner who is gone or
 * disabled — throws the same `X_API_KEY_INVALID`. A caller that can tell "revoked" from "unknown"
 * can enumerate ids.
 *
 * The owner is re-read on every verification, for the reason `authenticate` re-reads the user on
 * every request: a key is the owner's credential, so disabling the owner has to stop it on its
 * next use — not whenever somebody remembers to revoke it. The read happens only after the secret
 * matched, so an unauthenticated guess costs no second lookup.
 */
export async function verifyApiKey(
  store: ApiKeyVerifyStore,
  plaintext: string,
  clock: Clock = systemClock,
): Promise<VerifiedApiKey> {
  const parsed = typeof plaintext === 'string' ? parseApiKey(plaintext) : null;
  if (parsed === null) throw apiKeyInvalid();
  const record = await store.findApiKeyById(parsed.id);
  if (record === null) throw apiKeyInvalid();
  if (record.revokedAt !== null) throw apiKeyInvalid();
  const now = clock.now();
  if (record.expiresAt !== null && now.getTime() >= record.expiresAt.getTime()) {
    throw apiKeyInvalid();
  }
  if (!timingSafeEqual(sha256Hex(parsed.secret), record.keyHash)) throw apiKeyInvalid();
  const owner = record.userId === null ? null : await store.findUserById(record.userId);
  if (record.userId !== null && (owner === null || owner.disabledAt !== null)) {
    throw apiKeyInvalid();
  }
  await store.touchApiKey(record.id, now);
  return { record, owner };
}

export async function revokeApiKey(
  store: ApiKeyStore,
  id: string,
  clock: Clock = systemClock,
): Promise<boolean> {
  return await store.revokeApiKey(id, clock.now());
}

/**
 * What an owner may do, as far as this package can read it: the row's direct `permissions` and
 * `scopes`. ROLES are not here — expanding a role to permissions is `@ultimat3/policy`'s, which
 * this tier cannot import — so an app whose users hold roles passes `grantsOf` and expands them.
 */
export const directGrants = (owner: AuthUser): readonly string[] => [
  ...owner.permissions,
  ...owner.scopes,
];

export interface ApiKeyActorOptions {
  /**
   * The owner's effective grants, which a key's scopes are cut down to. Defaults to
   * `directGrants`. A role-based app passes its own expansion, e.g.
   * `(owner) => [...directGrants(owner), ...owner.roles.flatMap((role) => ROLE_GRANTS[role] ?? [])]`.
   */
  readonly grantsOf?: ((owner: AuthUser) => readonly string[]) | undefined;
}

/**
 * The agent actor for a verified key. Nothing is added: the key's scopes, minus any wildcard,
 * minus — for a key a user owns — whatever that user could not do themselves.
 */
export function apiKeyActor(
  verified: VerifiedApiKey,
  options: ApiKeyActorOptions = {},
): PolicyActor {
  const { record, owner } = verified;
  return actorFromApiKey(record, owner === null ? null : (options.grantsOf ?? directGrants)(owner));
}

/** Safe to render in a dashboard or return from an MCP tool: no hash, no secret. */
export interface ApiKeySummary {
  readonly id: string;
  readonly prefix: string;
  readonly scopes: readonly string[];
  readonly lastUsedAt: Date | null;
  readonly expiresAt: Date | null;
  readonly revokedAt: Date | null;
  readonly createdAt: Date;
}

export function describeApiKey(record: AuthApiKeyRecord): ApiKeySummary {
  return {
    id: record.id,
    prefix: record.prefix,
    scopes: record.scopes,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
    revokedAt: record.revokedAt,
    createdAt: record.createdAt,
  };
}
