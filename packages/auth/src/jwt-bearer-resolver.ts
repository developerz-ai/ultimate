// Single responsibility: an external issuer's bearer JWT → who is calling, in the `resolveToken`
// shape a bearer mount and an MCP endpoint take. `apiKeyResolver`'s twin for tokens: the checks are
// `verifyWorkloadToken`'s, and every refusal — a key set that cannot be read included — is `null`
// plus one log line naming the check, never a claim's value and never the token.

import { type Clock, logger, systemClock } from '@ultimat3/core';
import type { JwksKeySource } from './jwks';
import type { PolicyActor } from './policy-bridge';
import { checkWorkloadToken, type WorkloadCheck, type WorkloadToken } from './workload';

/** Structurally `ApiKeyCaller`: http's `BearerCaller` and mcp's `ResolvedToken`. */
export interface JwtBearerCaller {
  readonly actor: PolicyActor;
  /** The scopes the token carries (`scope` or `scp`). The mount's scope map is cut by these. */
  readonly scopes: ReadonlySet<string>;
}

export interface JwtBearerResolverOptions {
  /**
   * A THUNK, read when a token arrives: discovery opens no network at import, and a mount is
   * declared before boot. Hold the client and return it — a new one per call has an empty cache.
   */
  readonly keys: () => JwksKeySource | Promise<JwksKeySource>;
  /** Every issuer accepted. A list, never a wildcard. */
  readonly issuers: readonly string[];
  /** This app's own audience. */
  readonly audience: string;
  /** A scope the token must carry, when the mount needs one. The name is the app's. */
  readonly requiredScope?: string | undefined;
  /** The app's own claim check, after the signature held (`tid`, `azp`, `groups`). */
  readonly accept?: ((raw: Readonly<Record<string, unknown>>) => boolean) | undefined;
  /** Builds the actor. Roles and org are the app's decision, never guessed from a claim here. */
  readonly actorOf: (token: WorkloadToken) => PolicyActor;
  readonly clock?: Clock | undefined;
}

/** Every check a refusal can name: the token's own, then the three this resolver adds. */
export type JwtBearerCheck = WorkloadCheck | 'key-set' | 'scope' | 'accept';

const refuse = (check: JwtBearerCheck): null => {
  // The check's NAME only: a claim's value is the caller's text, and the token is a credential.
  logger.warn('auth.jwt_bearer.refused', { check });
  return null;
};

/**
 * `resolveToken: jwtBearerResolver({ keys, issuers, audience, actorOf })` on a bearer mount or
 * `defineAppMcp()`. A thrown `accept` or `actorOf` is the app's bug and propagates; a key source
 * that throws or rejects — discovery down, an unknown `kid` — fails closed as `null`.
 */
export function jwtBearerResolver(
  options: JwtBearerResolverOptions,
): (token: string) => Promise<JwtBearerCaller | null> {
  return async (token) => {
    let checked: Awaited<ReturnType<typeof checkWorkloadToken>>;
    try {
      checked = await checkWorkloadToken({
        token,
        keys: await options.keys(),
        issuers: options.issuers,
        audience: options.audience,
        clock: options.clock ?? systemClock,
      });
    } catch {
      // Deliberately unrendered: the throw may quote the issuer's response, and an unreadable key
      // set and an unknown `kid` must read the same to whoever is probing.
      return refuse('key-set');
    }
    if (!checked.ok) return refuse(checked.check);
    const verified = checked.token;
    if (
      options.requiredScope !== undefined &&
      !verified.claims.scopes.includes(options.requiredScope)
    ) {
      return refuse('scope');
    }
    if (options.accept !== undefined && !options.accept(verified.raw)) return refuse('accept');
    return { actor: options.actorOf(verified), scopes: new Set(verified.claims.scopes) };
  };
}
