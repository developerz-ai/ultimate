// The app's own `POST /mcp`, as `x new` writes it: `apps/web/mcp.ts` — the file and export the
// mount reads (`app-mcp.ts`) — over the `@<app>/mcp` catalog, and the token resolver that makes it a
// route. Mounted and REFUSING: no bearer, or one nobody issued, is a 401 before a tool is read. The
// development token works under `x dev` alone, and its test says so in every other environment.

import type { GeneratedFile, NameSet } from './naming';

const endpoint = (
  app: NameSet,
): string => `// The app's own MCP endpoint: \`POST /mcp\`, mounted by \`x dev\` and by the web role, which find
// this file by its path and its \`mcp\` export. The tools are \`@${app.kebab}/mcp\`'s catalog; who may
// call them is \`resolveAgentToken\`. Delete this file to unmount it — the boot then says
// X_MCP_APP_UNMOUNTED — or set \`ai: { mcp: { expose: false } }\` in app.config.ts.
//
// Built when the boot scan reaches this file, after \`apps/*/api\` registered its actions: a tool
// declared later in a running \`x dev\` is on \`POST /mcp\` from its next restart.
import { appMcp } from '@${app.kebab}/mcp';
import { resolveAgentToken } from './app/auth/agent-token';

export const mcp = appMcp({ resolveToken: resolveAgentToken });
`;

const endpointTest =
  (): string => `// The endpoint is mounted and refusing: a route at /mcp, and a 401 for a request that carries no
// token or one this process does not honour — before any tool, or the body, is read.
import { expect, unitTest } from '@ultimat3/testing';
import { DEV_AGENT_TOKEN_PREFIX } from './app/auth/agent-token';
import { mcp } from './mcp';

const post = (headers: Record<string, string>) =>
  new Request('http://localhost/mcp', { method: 'POST', headers, body: '{}' });

unitTest('POST /mcp is mounted, and answers 401 without a token', async () => {
  const route = mcp.route;
  if (route === undefined) return expect.unreachable('apps/web/mcp.ts built no route');
  expect(route.path).toBe('/mcp');
  const response = await route.handle(post({}));
  expect(response.status).toBe(401);
  // The development token is refused outside \`x dev\`: \`bun test\` is not development.
  const dev = await route.handle(post({ authorization: \`Bearer \${DEV_AGENT_TOKEN_PREFIX}admin\` }));
  expect(dev.status).toBe(401);
});
`;

const agentToken =
  (): string => `// Who an MCP caller is, for \`apps/web/mcp.ts\`: an API key issued through \`@ultimat3/auth\` —
// \`issueApiKey\`, stored in the framework's \`x_api_keys\` — resolved to an agent actor, in every
// environment. Under \`x dev\` alone, \`dev-agent.<role>\` is also an agent holding that declared role,
// so a local client can call the app's tools before the app issues keys. It FAILS CLOSED: a process
// naming no environment is production, where that token is refused like any unknown one.
import { type Auth, apiKeyResolver } from '@ultimat3/auth';
import { type Actor, agentActor, peerAddressClass, tryResolveEnvironment } from '@ultimat3/core';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { roles } from '../../shared/roles';
import { appAuth } from './auth';

/** \`Authorization: Bearer dev-agent.admin\` under \`x dev\`; refused everywhere else. */
export const DEV_AGENT_TOKEN_PREFIX = 'dev-agent.';

/** What \`defineAppMcp\`'s \`resolveToken\` answers: an agent, and the scopes its connection holds. */
export interface AgentCaller {
  readonly actor: Actor;
  readonly scopes: ReadonlySet<string>;
}

/** The development agent a token names, or \`null\` for a role \`shared/roles.ts\` never declared. */
export const devAgentFor = (token: string): AgentCaller | null => {
  const role = token.slice(DEV_AGENT_TOKEN_PREFIX.length);
  // \`Object.hasOwn\`, never \`in\`: a token saying \`constructor\` names no role.
  if (!Object.hasOwn(roles, role)) return null;
  return {
    actor: agentActor({ id: 'dev-agent', orgId: DEMO_ORG_ID, roles: [role] }),
    scopes: new Set(),
  };
};

export interface AgentTokenOptions {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The app's \`Auth\`, asked for when a key is presented, never at import. */
  readonly auth: () => Auth;
}

/** How the request arrived: the two facts \`defineAppMcp\` hands every resolver that this one reads. */
export interface CallerFacts {
  /** The \`Origin\` header: a browser sends one on every POST, a local MCP client none. */
  readonly origin: string | null;
  /** The caller's address as the host resolved it. */
  readonly address: string | null;
}

/**
 * The development token is honoured only from this machine and never from a browser: a page that
 * rebinds its name to 127.0.0.1 reaches \`x dev\` over loopback, but it sends \`Origin\`.
 */
const localClient = (facts: CallerFacts | undefined): boolean =>
  facts !== undefined &&
  facts.origin === null &&
  facts.address !== null &&
  peerAddressClass(facts.address) === 'loopback';

/** The resolver, over an environment and an \`Auth\` — so its test chooses both. */
export const agentTokenResolver = (options: AgentTokenOptions) => {
  const keys = apiKeyResolver(() => options.auth().adapter);
  return async (token: string, facts?: CallerFacts): Promise<AgentCaller | null> => {
    if (!token.startsWith(DEV_AGENT_TOKEN_PREFIX)) return await keys(token);
    const environment = tryResolveEnvironment({ env: options.env, fallback: 'production' });
    return environment === 'development' && localClient(facts) ? devAgentFor(token) : null;
  };
};

export const resolveAgentToken = agentTokenResolver({ env: process.env, auth: appAuth });
`;

const agentTokenTest =
  (): string => `// An issued key is an agent of its org everywhere; the development token is an agent under
// \`x dev\` and nothing anywhere else — including a process that names no environment at all.
import { defineAuth, issueApiKey, memoryAuthAdapter } from '@ultimat3/auth';
import { expect, unitTest } from '@ultimat3/testing';
import { DEMO_ORG_ID } from '../../shared/demo-org';
import { agentTokenResolver, DEV_AGENT_TOKEN_PREFIX, resolveAgentToken } from './agent-token';

/** In memory: the key store is the package's, and this test is about the wiring around it. */
const memoryAuth = () => {
  const auth = defineAuth({ adapter: memoryAuthAdapter() });
  return () => auth;
};

unitTest('an issued API key is an agent of its org, in every environment', async () => {
  const auth = memoryAuth();
  const issued = issueApiKey({ env: 'dev', scopes: [], orgId: DEMO_ORG_ID });
  await auth().adapter.putApiKey(issued.record);
  for (const ULTIMATE_ENV of ['development', 'production']) {
    const caller = await agentTokenResolver({ env: { ULTIMATE_ENV }, auth })(issued.plaintext);
    expect(caller?.actor.kind).toBe('agent');
    expect(caller?.actor.orgId).toBe(DEMO_ORG_ID);
  }
  // One character off the secret is nobody.
  const resolve = agentTokenResolver({ env: {}, auth });
  expect(await resolve(\`\${issued.plaintext}x\`)).toBeNull();
});

/** A local, non-browser client: what \`x dev\`'s own MCP clients are. */
const LOCAL = { origin: null, address: '127.0.0.1' };

unitTest('dev-agent.<role> is that declared role under x dev, and nobody elsewhere', async () => {
  const auth = memoryAuth();
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, auth });
  const admin = \`\${DEV_AGENT_TOKEN_PREFIX}admin\`;
  expect((await dev(admin, LOCAL))?.actor.roles).toEqual(['admin']);
  expect(await dev(\`\${DEV_AGENT_TOKEN_PREFIX}nobody\`, LOCAL)).toBeNull();
  expect(await dev(\`\${DEV_AGENT_TOKEN_PREFIX}constructor\`, LOCAL)).toBeNull();
  for (const env of [{ ULTIMATE_ENV: 'production' }, { ULTIMATE_ENV: 'staging' }, {}]) {
    expect(await agentTokenResolver({ env, auth })(admin, LOCAL)).toBeNull();
  }
});

unitTest('the development token is refused from a browser or from off this machine', async () => {
  // A hostile page that rebinds its name to 127.0.0.1 reaches \`x dev\` from a loopback socket,
  // but a browser sends Origin on every POST; another machine on the network has no loopback address.
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, auth: memoryAuth() });
  const admin = \`\${DEV_AGENT_TOKEN_PREFIX}admin\`;
  expect(await dev(admin, { origin: 'http://rebound.test:3000', address: '127.0.0.1' })).toBeNull();
  expect(await dev(admin, { origin: 'null', address: '::1' })).toBeNull();
  expect(await dev(admin, { origin: null, address: '192.168.1.20' })).toBeNull();
  expect(await dev(admin, { origin: null, address: null })).toBeNull();
  expect(await dev(admin)).toBeNull();
  expect((await dev(admin, { origin: null, address: '::1' }))?.actor.kind).toBe('agent');
});

unitTest('the installed resolver refuses the development token under bun test', async () => {
  // \`bun test\` sets NODE_ENV=test: not development, so no key store is ever asked.
  expect(await resolveAgentToken(\`\${DEV_AGENT_TOKEN_PREFIX}admin\`)).toBeNull();
});
`;

/** `apps/web/mcp.ts`, the resolver it mounts with, and the tests that pin both refusing. */
export const mcpEndpointFiles = (app: NameSet): readonly GeneratedFile[] => [
  { path: 'apps/web/mcp.ts', contents: endpoint(app) },
  { path: 'apps/web/mcp.test.ts', contents: endpointTest() },
  { path: 'apps/web/app/auth/agent-token.ts', contents: agentToken() },
  { path: 'apps/web/app/auth/agent-token.test.ts', contents: agentTokenTest() },
];
