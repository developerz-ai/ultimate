// `mcpAuthorizationServer`: `@ultimat3/auth`'s `authorizationServer` bound to ONE MCP endpoint —
// every grant bound to its `resource` (RFC 8707), the `resolveToken` that refuses any other, the
// `oauth` block `defineAppMcp` advertises, and each decision as an `mcp.auth.*` line. No second
// implementation: every protocol rule is auth's; this file only binds and audits.

import {
  type AuthorizationServer,
  type AuthorizationServerOptions,
  type AuthServerEvent,
  authorizationServer,
  oauthBearerResolver,
  type ResolvedGrant,
} from '@ultimat3/auth';
import type { Actor, Logger } from '@ultimat3/core';
import { logger } from '@ultimat3/core';
import type { McpOAuth } from './oauth-metadata';
import type { ResolvedToken } from './transport-http';

export interface McpAuthorizationServerOptions
  extends Omit<AuthorizationServerOptions, 'defaultResource'> {
  /** The MCP endpoint's canonical URL, e.g. `https://www.example.com/mcp`. Every grant binds to it. */
  readonly resource: string;
  /** What a subject is NOW — built per call, so a removed member loses access with no sweep. */
  readonly actor: (grant: ResolvedGrant) => Promise<Actor | null> | Actor | null;
  /** `oauth.resourceName`: what a client's consent screen shows. */
  readonly resourceName?: string | undefined;
  /** Where the `mcp.auth.*` lines go. The process logger unless a test reads them. */
  readonly log?: Logger | undefined;
}

export interface McpAuthorizationServer extends AuthorizationServer {
  readonly resource: string;
  /** Hand to `defineAppMcp({ oauth })`: the 401 then names this server. */
  readonly oauth: McpOAuth;
  /** Hand to `defineAppMcp({ resolveToken })`: a token bound to `resource`, or `null`. */
  resolveToken(token: string): Promise<ResolvedToken | null>;
}

/** Replays are the shape of a stolen credential: `warn`, the level an alert rule reads. */
const WARN_KINDS: ReadonlySet<AuthServerEvent['kind']> = new Set([
  'code-replayed',
  'refresh-replayed',
  'grant-disabled',
]);

export function mcpAuthorizationServer(
  options: McpAuthorizationServerOptions,
): McpAuthorizationServer {
  const log = options.log ?? logger;
  const resources = [options.resource, ...(options.resources ?? [])];
  const server = authorizationServer({
    ...options,
    resources: [...new Set(resources)],
    // A client that names no resource still gets a token for THIS endpoint, never an unbound one.
    defaultResource: options.resource,
    onEvent(event) {
      const fields = {
        surface: 'mcp',
        ...(event.error === undefined ? {} : { error: event.error }),
        ...(event.grantType === undefined ? {} : { grantType: event.grantType }),
        ...(event.clientId === undefined ? {} : { clientId: event.clientId }),
      };
      if (WARN_KINDS.has(event.kind)) log.warn(`mcp.auth.${event.kind}`, fields);
      else log.info(`mcp.auth.${event.kind}`, fields);
      options.onEvent?.(event);
    },
  });
  const resolve = oauthBearerResolver(server, { actor: options.actor, resource: options.resource });
  return {
    ...server,
    resource: options.resource,
    oauth: {
      authorizationServers: [server.issuer],
      resource: options.resource,
      scopesSupported: options.scopes,
      ...(options.resourceName === undefined ? {} : { resourceName: options.resourceName }),
    },
    resolveToken: resolve,
  };
}
