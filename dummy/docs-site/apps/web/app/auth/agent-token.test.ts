// An issued key is an agent of its org everywhere; the development token is an agent under
// `x dev` and nothing anywhere else — including a process that names no environment at all.
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
  expect(await resolve(`${issued.plaintext}x`)).toBeNull();
});

/** A local, non-browser client: what `x dev`'s own MCP clients are. */
const LOCAL = { origin: null, address: '127.0.0.1' };

unitTest('dev-agent.<role> is that declared role under x dev, and nobody elsewhere', async () => {
  const auth = memoryAuth();
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, auth });
  const admin = `${DEV_AGENT_TOKEN_PREFIX}admin`;
  expect((await dev(admin, LOCAL))?.actor.roles).toEqual(['admin']);
  expect(await dev(`${DEV_AGENT_TOKEN_PREFIX}nobody`, LOCAL)).toBeNull();
  expect(await dev(`${DEV_AGENT_TOKEN_PREFIX}constructor`, LOCAL)).toBeNull();
  for (const env of [{ ULTIMATE_ENV: 'production' }, { ULTIMATE_ENV: 'staging' }, {}]) {
    expect(await agentTokenResolver({ env, auth })(admin, LOCAL)).toBeNull();
  }
});

unitTest('the development token is refused from a browser or from off this machine', async () => {
  // A hostile page that rebinds its name to 127.0.0.1 reaches `x dev` from a loopback socket,
  // but a browser sends Origin on every POST; another machine on the network has no loopback address.
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, auth: memoryAuth() });
  const admin = `${DEV_AGENT_TOKEN_PREFIX}admin`;
  expect(await dev(admin, { origin: 'http://rebound.test:3000', address: '127.0.0.1' })).toBeNull();
  expect(await dev(admin, { origin: 'null', address: '::1' })).toBeNull();
  expect(await dev(admin, { origin: null, address: '192.168.1.20' })).toBeNull();
  expect(await dev(admin, { origin: null, address: null })).toBeNull();
  expect(await dev(admin)).toBeNull();
  expect((await dev(admin, { origin: null, address: '::1' }))?.actor.kind).toBe('agent');
});

unitTest('the installed resolver refuses the development token under bun test', async () => {
  // `bun test` sets NODE_ENV=test: not development, so no key store is ever asked.
  expect(await resolveAgentToken(`${DEV_AGENT_TOKEN_PREFIX}admin`)).toBeNull();
});
