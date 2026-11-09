// An issued key is an agent of its org everywhere; the development token is an agent under
// `x dev` and nothing anywhere else — including a process that names no environment at all.
import { agentActor } from '@ultimat3/core';
import { expect, unitTest } from '@ultimat3/testing';
import {
  type AgentCaller,
  agentTokenResolver,
  DEMO_AGENT_ORG_ID,
  DEV_AGENT_TOKEN_PREFIX,
  resolveAgentToken,
} from './agent-token';

/** A key store holding one key: the store is `@ultimat3/auth`'s, this test is about the wiring. */
const ISSUED = 'ult_dev_issued';
const keys = async (token: string): Promise<AgentCaller | null> =>
  token === ISSUED
    ? { actor: agentActor({ id: 'k1', orgId: DEMO_AGENT_ORG_ID, roles: [] }), scopes: new Set() }
    : null;

/** A local, non-browser client: what `x dev`'s own MCP clients are. */
const LOCAL = { origin: null, address: '127.0.0.1' };
const OWNER = `${DEV_AGENT_TOKEN_PREFIX}owner`;

unitTest('an issued key is an agent of its org, in every environment', async () => {
  for (const ULTIMATE_ENV of ['development', 'production']) {
    const caller = await agentTokenResolver({ env: { ULTIMATE_ENV }, keys })(ISSUED);
    expect(caller?.actor.orgId).toBe(DEMO_AGENT_ORG_ID);
  }
  expect(await agentTokenResolver({ env: {}, keys })(`${ISSUED}x`)).toBeNull();
});

unitTest('dev-agent.<role> is that declared role under x dev, and nobody elsewhere', async () => {
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, keys });
  const owner = await dev(OWNER, LOCAL);
  expect(owner?.actor.roles).toEqual(['owner']);
  expect(owner?.actor.kind).toBe('agent');
  expect(owner?.actor.orgId).toBe(DEMO_AGENT_ORG_ID);
  expect(await dev(`${DEV_AGENT_TOKEN_PREFIX}nobody`, LOCAL)).toBeNull();
  expect(await dev(`${DEV_AGENT_TOKEN_PREFIX}constructor`, LOCAL)).toBeNull();
  for (const env of [{ ULTIMATE_ENV: 'production' }, { ULTIMATE_ENV: 'staging' }, {}]) {
    expect(await agentTokenResolver({ env, keys })(OWNER, LOCAL)).toBeNull();
  }
});

unitTest('the development token is refused from a browser or from off this machine', async () => {
  // A page that rebinds its name to 127.0.0.1 reaches `x dev` over loopback, but a browser sends
  // Origin on every POST; another machine on the network has no loopback address.
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, keys });
  expect(await dev(OWNER, { origin: 'http://rebound.test:3000', address: '127.0.0.1' })).toBeNull();
  expect(await dev(OWNER, { origin: 'null', address: '::1' })).toBeNull();
  expect(await dev(OWNER, { origin: null, address: '192.168.1.20' })).toBeNull();
  expect(await dev(OWNER, { origin: null, address: null })).toBeNull();
  expect(await dev(OWNER)).toBeNull();
  expect((await dev(OWNER, { origin: null, address: '::1' }))?.actor.kind).toBe('agent');
});

unitTest('the installed resolver refuses the development token under bun test', async () => {
  // `bun test` sets NODE_ENV=test: not development.
  expect(await resolveAgentToken(OWNER, LOCAL)).toBeNull();
});
