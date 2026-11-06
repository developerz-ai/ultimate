// Single responsibility: an authorization server's access token → who is calling, in the shape a
// bearer mount and an MCP endpoint both take as `resolveToken`. The `Actor` is built PER CALL by
// the app's `actor`, never stored with the grant: a member removed from the org loses access on
// the next request with no sweep. `resource`, when given, refuses a token bound to anything else.

import type { Actor } from '@ultimat3/core';
import type { ResolvedGrant } from './authorization-server-types';

/** Structurally `@ultimat3/http`'s `BearerCaller` and `@ultimat3/mcp`'s `ResolvedToken`. */
export interface OAuthBearerCaller {
  readonly actor: Actor;
  /** What the person (or machine) granted — the mount's scope map is cut by these. */
  readonly scopes: ReadonlySet<string>;
}

export interface OAuthBearerResolverOptions {
  /**
   * Required: what a subject is NOW. `null` refuses the token — a removed member, a disabled
   * account, a client the app no longer trusts. `grant.subject` is the client id itself for a
   * `client_credentials` token.
   */
  readonly actor: (grant: ResolvedGrant) => Promise<Actor | null> | Actor | null;
  /** RFC 8707: accept only tokens bound to this resource. Unbound tokens are refused too. */
  readonly resource?: string | undefined;
}

/** What it needs of `authorizationServer()` — its `resolve`, and nothing else. */
export interface OAuthTokenSource {
  resolve(token: string): Promise<ResolvedGrant | null>;
}

export function oauthBearerResolver(
  server: OAuthTokenSource,
  options: OAuthBearerResolverOptions,
): (token: string) => Promise<OAuthBearerCaller | null> {
  return async (token) => {
    const grant = await server.resolve(token);
    if (grant === null) return null;
    if (options.resource !== undefined && grant.resource !== options.resource) return null;
    const actor = await options.actor(grant);
    if (actor === null) return null;
    return { actor, scopes: grant.scopes };
  };
}
