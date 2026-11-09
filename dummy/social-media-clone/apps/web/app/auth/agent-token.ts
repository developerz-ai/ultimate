// Who an MCP caller is, for `apps/web/mcp.ts`: an API key issued through `@ultimat3/auth` —
// `issueApiKey`, stored in the framework's `x_api_keys` — resolved to an agent actor, in every
// environment. Under `x dev` alone, `dev-agent.<role>` is also an agent holding that declared role,
// so a local client can call the app's tools before the app issues keys. It FAILS CLOSED: a process
// naming no environment is production, where that token is refused like any unknown one. An agent
// carries no relational facts (`shared/actor.ts`), so every row-level rule reads it as a stranger.
import { type Auth, apiKeyResolver } from '@ultimat3/auth';
import { type Actor, agentActor, peerAddressClass, tryResolveEnvironment } from '@ultimat3/core';
import { roleDefinitions } from '@ultimat3/policy';
import { appAuth } from './auth';

/** `Authorization: Bearer dev-agent.member` under `x dev`; refused everywhere else. */
export const DEV_AGENT_TOKEN_PREFIX = 'dev-agent.';

/** What `defineAppMcp`'s `resolveToken` answers: an agent, and the scopes its connection holds. */
export interface AgentCaller {
  readonly actor: Actor;
  readonly scopes: ReadonlySet<string>;
}

/** The development agent a token names, or `null` for a role no `defineRoles` declared. */
export const devAgentFor = (token: string): AgentCaller | null => {
  const role = token.slice(DEV_AGENT_TOKEN_PREFIX.length);
  // `Object.hasOwn`, never `in`: a token saying `constructor` names no role.
  if (!Object.hasOwn(roleDefinitions(), role)) return null;
  return { actor: agentActor({ id: 'dev-agent', roles: [role] }), scopes: new Set() };
};

export interface AgentTokenOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The app's `Auth`, asked for when a key is presented, never at import. */
  readonly auth: () => Auth;
}

/** How the request arrived: the two facts `defineAppMcp` hands every resolver that this one reads. */
export interface CallerFacts {
  /** The `Origin` header: a browser sends one on every POST, a local MCP client none. */
  readonly origin: string | null;
  /** The caller's address as the host resolved it. */
  readonly address: string | null;
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

/** The resolver, over an environment and an `Auth` — so its test chooses both. */
export const agentTokenResolver = (options: AgentTokenOptions) => {
  const keys = apiKeyResolver(() => options.auth().adapter);
  return async (token: string, facts?: CallerFacts): Promise<AgentCaller | null> => {
    if (!token.startsWith(DEV_AGENT_TOKEN_PREFIX)) return await keys(token);
    const environment = tryResolveEnvironment({ env: options.env, fallback: 'production' });
    return environment === 'development' && localClient(facts) ? devAgentFor(token) : null;
  };
};

export const resolveAgentToken = agentTokenResolver({ env: process.env, auth: appAuth });
