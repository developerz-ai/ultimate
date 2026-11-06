/**
 * Postly's OAuth authorization server, for a partner's machine: a nightly sync of the public blog
 * that authenticates as itself, gets its own allowance and can be revoked, instead of scraping the
 * site anonymously. One `authorizationServer` call; the RFC wire is the framework's, mounted
 * through `apps/web/runtime.ts`, and its tokens open the `/partner` mount (`api/index.ts`).
 *
 * `client_credentials` alone: no person consents to a machine, so no consent page is owed.
 */

import type { AuthServerStore, ResolvedGrant } from '@ultimat3/auth';
import {
  authorizationServer,
  memoryAuthServerStore,
  oauthBearerResolver,
  postgresAuthServerStore,
} from '@ultimat3/auth';
import { type Actor, serviceActor, storeMode } from '@ultimat3/core';
import { dbExecutor } from '@ultimat3/db';
import { appOrigin } from '../../shared/app-origin';

/** What a partner token may do, and the one map the `/partner` mount cuts its routes by. */
export const PARTNER_SCOPES = {
  'posts:read': ['publicPosts', 'publicPost'],
} as const;

/** A scope a partner client can hold: a key of the map, so an unknown one is a type error. */
export type PartnerScope = keyof typeof PARTNER_SCOPES;

/**
 * `x_oauth_*` (framework tables the boot applies) through `@ultimat3/db`'s one executor builder,
 * everywhere except `bun test` — core's `storeMode`, the rule `@postly/mcp`'s confirmations follow.
 */
const store: AuthServerStore =
  storeMode(Bun.env) === 'memory'
    ? memoryAuthServerStore()
    : postgresAuthServerStore({ executor: dbExecutor() });

export const partnerOAuth = authorizationServer({
  // The origin a client checks every answer against (RFC 9207).
  issuer: appOrigin(),
  store,
  // Advertised as RFC 8414's `authorization_endpoint`; no grant enabled here ever sends a person
  // to it. The page is owed the day a person-facing grant is.
  consentPath: '/oauth/consent',
  // A machine token lives fifteen minutes: the sync re-asks with its secret, nothing to refresh.
  lifetimes: { accessSeconds: 600, refreshIdleDays: 30, clientSeconds: 900 },
  scopes: Object.keys(PARTNER_SCOPES),
  grants: ['client_credentials'],
});

/**
 * Who a token is NOW, per call: a client-credentials token's subject is the client itself, and it
 * acts as a service holding exactly the scopes it was granted. A token whose subject is anyone
 * else was minted by a grant this server does not enable, and opens nothing here.
 */
export const partnerActor = (grant: ResolvedGrant): Actor | null =>
  grant.subject === grant.clientId
    ? serviceActor({ id: `partner:${grant.clientId}`, scopes: [...grant.scopes] })
    : null;

/** The mount's `resolveToken`: an unknown, expired or revoked token is one `null`. */
export const resolvePartnerToken = oauthBearerResolver(partnerOAuth, { actor: partnerActor });

/** A partner's confidential client. The secret is shown once, here; only its hash is stored. */
export async function registerPartner(input: {
  readonly name: string;
  readonly scopes?: readonly PartnerScope[];
}): Promise<{ readonly clientId: string; readonly clientSecret: string | null }> {
  const { client, clientSecret } = await partnerOAuth.registerClient({
    name: input.name,
    authMethod: 'client_secret_basic',
    grantTypes: ['client_credentials'],
    scopes: [...(input.scopes ?? Object.keys(PARTNER_SCOPES))],
  });
  return { clientId: client.clientId, clientSecret };
}
