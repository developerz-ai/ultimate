/**
 * What an idempotency record is filed under: the action, the CALLER, and the caller's key —
 * one JSON tuple, so no part of it can spell another. A key scoped to the action name alone was a
 * key space every caller shared, and a blank header is refused rather than read as no key at all.
 */
import type { Actor } from '@ultimat3/core';
import { IdempotencyKeyInvalidError } from './errors';

/**
 * The bound the OpenAPI operation has always published for the `Idempotency-Key` parameter. It is
 * enforced here so the spec and the runtime say the same thing — and because the key is
 * caller-chosen, which makes its length the caller's choice of how much store to occupy.
 */
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

/**
 * Keys are namespaced per action AND per caller: the same key under two actions is two keys, and
 * the same key from two callers is two keys.
 *
 * The caller half is the fix for a real replay across identities — alice POSTs `charge` with a
 * key, bob POSTs `charge` with the same key and was handed alice's stored response; with a
 * differing payload bob got `X_IDEMPOTENCY_CONFLICT` instead, so any key he guessed was a key he
 * could deny her.
 *
 * **The encoding is a JSON tuple and never a joined string**, the reasoning `@ultimat3/query`'s
 * `readAuthority` states: an actor id is app data, so a caller who can choose one can spell
 * whatever separator the key uses. Under `${action}:${id}:${key}`, id `alice:x` with key `y` and
 * id `alice` with key `x:y` are one record. Fixed arity plus JSON escaping means no value can
 * move a boundary.
 *
 * The limit it does NOT close: an anonymous actor has no identity to narrow to, so every
 * anonymous caller of a public idempotent action still shares one key space. Nothing at this tier
 * can tell two of them apart, and narrowing to something that is not identity (an IP, a session
 * cookie) would break the retry it exists to serve.
 */
export function idempotencyKeyFor(actionName: string, key: string, actor: Actor): string {
  if (key.trim().length === 0) {
    throw new IdempotencyKeyInvalidError(actionName, 'empty', key.length);
  }
  if (key.length > MAX_IDEMPOTENCY_KEY_LENGTH) {
    throw new IdempotencyKeyInvalidError(actionName, 'too-long', key.length);
  }
  // The same three fields every other caller-scoped key in the framework is built from
  // (`readAuthority`, `scopeKey`): kind, id, org. Two of them alone is one identity too few —
  // a `service` and a `user` may hold the same id, and one actor's org is what a tenant sees.
  return JSON.stringify([actionName, actor.kind, actor.id, actor.orgId ?? null, key]);
}
