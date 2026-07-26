// Single responsibility: machine credentials. This is how an agent — an MCP client driving a
// generated Ultimate app — authenticates: it presents a key, the key resolves to an
// `agentActor` carrying exactly the key's scopes, and it goes through the same policy
// evaluation a human does. The plaintext is shown once; only its SHA-256 is ever stored, and
// lookup happens by the non-secret id so the secret never appears in a query, an index or a log.

import { type Clock, randomHex, systemClock } from '@ultimat3/core';
import type { ApiKeyStore, AuthApiKeyRecord } from './adapter';
import { apiKeyInvalid } from './errors';
import type { PolicyActor } from './policy-bridge';
import { actorFromApiKey } from './policy-bridge';
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

export function issueApiKey(input: IssueApiKeyInput): IssuedApiKey {
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

/**
 * Every rejection — malformed, unknown, revoked, expired, wrong secret — throws the same
 * `X_API_KEY_INVALID`. A caller that can tell "revoked" from "unknown" can enumerate ids.
 */
export async function verifyApiKey(
  store: ApiKeyStore,
  plaintext: string,
  clock: Clock = systemClock,
): Promise<AuthApiKeyRecord> {
  const parsed = parseApiKey(plaintext);
  if (parsed === null) throw apiKeyInvalid();
  const record = await store.findApiKeyById(parsed.id);
  if (record === null) throw apiKeyInvalid();
  if (record.revokedAt !== null) throw apiKeyInvalid();
  const now = clock.now();
  if (record.expiresAt !== null && now.getTime() >= record.expiresAt.getTime()) {
    throw apiKeyInvalid();
  }
  if (!timingSafeEqual(sha256Hex(parsed.secret), record.keyHash)) throw apiKeyInvalid();
  await store.touchApiKey(record.id, now);
  return record;
}

export async function revokeApiKey(
  store: ApiKeyStore,
  id: string,
  clock: Clock = systemClock,
): Promise<boolean> {
  return await store.revokeApiKey(id, clock.now());
}

/** The agent actor for a verified key. Scopes in, scopes out — nothing is added. */
export function apiKeyActor(record: AuthApiKeyRecord): PolicyActor {
  return actorFromApiKey(record);
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
