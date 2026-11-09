// Who a staff MCP caller is, for `apps/admin/mcp.ts`, as `x new` writes it: an issued API key
// (`resolveOrgKey`, the `x_api_keys` store `/mcp` and `/v1` read) in every environment, and under
// `x dev` alone `dev-agent.<role>`, an agent holding that declared role in the demo org. It FAILS
// CLOSED: a process naming no environment is production, where that token is refused.
import { type Actor, agentActor, peerAddressClass, tryResolveEnvironment } from '@ultimat3/core';
import { roles } from '../../shared/policies';
import { resolveOrgKey } from '../runs/keys';
import { DEFAULT_DEMO_MEMBER, DEMO_VIEWERS } from './demo-actor';

/** `Authorization: Bearer dev-agent.owner` under `x dev`; refused everywhere else. */
export const DEV_AGENT_TOKEN_PREFIX = 'dev-agent.';

/** The tenant a development agent acts in: the demo viewer's org, which the seed fills. */
export const DEMO_AGENT_ORG_ID = DEMO_VIEWERS[DEFAULT_DEMO_MEMBER].org.id;

/** What `defineAppMcp`'s `resolveToken` answers: an agent, and the scopes its connection holds. */
export interface AgentCaller {
  readonly actor: Actor;
  readonly scopes: ReadonlySet<string>;
}

/** The development agent a token names, or `null` for a role `shared/policies.ts` never declared. */
export const devAgentFor = (token: string): AgentCaller | null => {
  const role = token.slice(DEV_AGENT_TOKEN_PREFIX.length);
  // `Object.hasOwn`, never `in`: a token saying `constructor` names no role.
  if (!Object.hasOwn(roles, role)) return null;
  return {
    actor: agentActor({ id: 'dev-agent', orgId: DEMO_AGENT_ORG_ID, roles: [role] }),
    scopes: new Set(),
  };
};

/** How the request arrived: the two facts `defineAppMcp` hands every resolver that this one reads. */
export interface CallerFacts {
  /** The `Origin` header: a browser sends one on every POST, a local MCP client none. */
  readonly origin: string | null;
  /** The caller's address as the host resolved it. */
  readonly address: string | null;
}

export interface AgentTokenOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** An issued key's resolver; the app's own store by default, so a test chooses the keys. */
  readonly keys?: (token: string) => Promise<AgentCaller | null>;
}

/**
 * The development token is honoured only from this machine and never from a browser: a page that
 * rebinds its name to 127.0.0.1 reaches `x dev` over loopback, but it sends `Origin`.
 */
const localClient = (facts: CallerFacts | undefined): boolean =>
  facts !== undefined &&
  facts.origin === null &&
  facts.address !== null &&
  peerAddressClass(facts.address) === 'loopback';

/** The resolver, over an environment and a key store — so its test chooses both. */
export const agentTokenResolver = (options: AgentTokenOptions) => {
  const keys = options.keys ?? resolveOrgKey;
  return async (token: string, facts?: CallerFacts): Promise<AgentCaller | null> => {
    if (!token.startsWith(DEV_AGENT_TOKEN_PREFIX)) return await keys(token);
    const environment = tryResolveEnvironment({ env: options.env, fallback: 'production' });
    return environment === 'development' && localClient(facts) ? devAgentFor(token) : null;
  };
};

export const resolveAgentToken = agentTokenResolver({ env: Bun.env });
