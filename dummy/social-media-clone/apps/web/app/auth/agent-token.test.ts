// An issued key is an agent everywhere; the development token is an agent under `x dev`, from this
// machine, and nothing anywhere else — including a process that names no environment at all.
import { defineAuth, issueApiKey, memoryAuthAdapter } from '@ultimat3/auth';
import { expect, unitTest } from '@ultimat3/testing';
import { agentTokenResolver, DEV_AGENT_TOKEN_PREFIX, resolveAgentToken } from './agent-token';
import './roles';

/** In memory: the key store is the package's, and this test is about the wiring around it. */
const memoryAuth = () => {
  const auth = defineAuth({ adapter: memoryAuthAdapter() });
  return () => auth;
};

/** A local, non-browser client: what `x dev`'s own MCP clients are. */
const LOCAL = { origin: null, address: '127.0.0.1' };

unitTest('an issued API key is an agent, in every environment', async () => {
  const auth = memoryAuth();
  const issued = issueApiKey({ env: 'dev', scopes: [] });
  await auth().adapter.putApiKey(issued.record);
  for (const ULTIMATE_ENV of ['development', 'production']) {
    const caller = await agentTokenResolver({ env: { ULTIMATE_ENV }, auth })(issued.plaintext);
    expect(caller?.actor.kind).toBe('agent');
  }
  // One character off the secret is nobody.
  expect(await agentTokenResolver({ env: {}, auth })(`${issued.plaintext}x`)).toBeNull();
});

unitTest('dev-agent.<role> is that declared role under x dev, from this machine only', async () => {
  const auth = memoryAuth();
  const dev = agentTokenResolver({ env: { ULTIMATE_ENV: 'development' }, auth });
  const member = `${DEV_AGENT_TOKEN_PREFIX}member`;
  expect((await dev(member, LOCAL))?.actor.roles).toEqual(['member']);
  expect(await dev(`${DEV_AGENT_TOKEN_PREFIX}nobody`, LOCAL)).toBeNull();
  expect(await dev(`${DEV_AGENT_TOKEN_PREFIX}constructor`, LOCAL)).toBeNull();
  expect(
    await dev(member, { origin: 'http://rebound.test:3000', address: '127.0.0.1' }),
  ).toBeNull();
  expect(await dev(member, { origin: null, address: '192.168.1.20' })).toBeNull();
  for (const env of [{ ULTIMATE_ENV: 'production' }, { ULTIMATE_ENV: 'staging' }, {}]) {
    expect(await agentTokenResolver({ env, auth })(member, LOCAL)).toBeNull();
  }
});

unitTest('the installed resolver refuses the development token under bun test', async () => {
  expect(await resolveAgentToken(`${DEV_AGENT_TOKEN_PREFIX}member`)).toBeNull();
});
