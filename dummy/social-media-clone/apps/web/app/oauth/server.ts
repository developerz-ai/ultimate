// The demo's OAuth authorization server for its own `/mcp`: an MCP client (Claude, an IDE) reads
// the 401's `resource_metadata`, finds this server, sends the person to `/oauth/consent`, and gets a
// token bound to `<APP_URL>/mcp`. One `mcpAuthorizationServer` call — every protocol rule is
// `@ultimat3/auth`'s; the wire is mounted by `apps/web/runtime.ts`, the consent page is this app's.

import { storesInPostgres, type User } from '@social-media-clone/db';
import type { AuthServerStore, ResolvedGrant } from '@ultimat3/auth';
import { memoryAuthServerStore, postgresAuthServerStore } from '@ultimat3/auth';
import { type Actor, agentActor } from '@ultimat3/core';
import { dbExecutor } from '@ultimat3/db';
import { useRequestContext } from '@ultimat3/http';
import { mcpAuthorizationServer } from '@ultimat3/mcp';
import { userById } from '../auth/repo';

/** The scope an MCP client asks for: the whole agent surface, as the API keys grant it. */
export const MCP_SCOPE = 'mcp';

/** The public origin, as `production-env.ts` requires it in production; loopback under test. */
export const appOrigin = (): string =>
  (Bun.env['APP_URL'] || 'http://localhost:3000').replace(/\/+$/, '');

/** `x_oauth_*` (in `packages/db/schema/framework`) wherever rows live in Postgres — the auth slice's rule. */
const store: AuthServerStore = storesInPostgres(Bun.env)
  ? postgresAuthServerStore({ executor: dbExecutor() })
  : memoryAuthServerStore();

/** A person who may act at all — the rule `app/auth/viewer.ts` applies to a session. */
const canAct = (user: User | null): user is User =>
  user !== null && user.deletedAt === null && !user.suspended;

/**
 * Who a token is NOW, per call: an agent acting for the person who consented, holding that
 * person's role — so a suspended or deleted account loses its tokens with no sweep. An agent
 * carries no relational facts (`shared/actor.ts`), exactly as an API-key agent does.
 */
export const oauthActor = async (grant: ResolvedGrant): Promise<Actor | null> => {
  const user = await userById(grant.subject);
  if (!canAct(user)) return null;
  return agentActor({
    id: `oauth:${grant.clientId}:${user.id}`,
    roles: [user.role],
    onBehalfOf: { actorKind: 'user', actorId: user.id },
  });
};

export const mcpOAuth = mcpAuthorizationServer({
  issuer: appOrigin(),
  store,
  consentPath: '/oauth/consent',
  resource: `${appOrigin()}/mcp`,
  resourceName: 'Social Demo',
  // An hour of access, refreshed while used; a client unused for a month signs in again.
  lifetimes: { accessSeconds: 3_600, refreshIdleDays: 30 },
  scopes: [MCP_SCOPE],
  // MCP clients register themselves (RFC 7591); a https client id is a metadata document too.
  registration: 'dynamic',
  actor: oauthActor,
});

/** The deciding request's address: the limiter key a metadata-document fetch is counted under. */
export const callerKey = (): string => useRequestContext('the consent read').ip ?? 'unknown';

/** An https `client_id` is a metadata document its own domain publishes (MCP 2025-11-25). */
export const isMetadataClient = (clientId: string | null): boolean =>
  clientId !== null && URL.parse(clientId)?.protocol === 'https:';

/**
 * Whether a refusal may go back to the client's `redirect_uri`. Only a metadata-document client's:
 * its redirect URIs are published by the domain that names it. A self-registered client's are
 * whatever the registrant typed, and following one makes this origin an open redirector.
 */
export const mayRedirectRefusal = (query: URLSearchParams): boolean =>
  isMetadataClient(query.get('client_id'));

/** A URL's host, as the consent page shows it — where a code goes, who a client is. */
export const hostOf = (url: string): string => URL.parse(url)?.host ?? url;
