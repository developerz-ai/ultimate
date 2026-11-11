/**
 * unit — the SSO mount `runtime.ts` loads in every role: nothing when unconfigured, the framework's
 * own `meta` on each leg (held against the built legs, so it cannot drift into a 403), and a bad IdP
 * config failing these two legs with a logged code instead of the import that every role makes.
 */

import { memoryAuthAdapter } from '@ultimat3/auth';
import { frozenClock, installLogSink } from '@ultimat3/core';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { expect, fakeSamlIdentityProvider, unitTest } from '@ultimat3/testing';
import { postlyAuth } from './login';
import { postlySso, spEntityId } from './sso';
import { ACS_META, START_META, ssoRoutes } from './sso-routes';

const ORIGIN = 'https://postly.test';

/** A function compares by reference: what matters is that it is there and answers no actor. */
const shape = (meta: { readonly name: string; readonly authenticate?: unknown }) => ({
  ...meta,
  authenticate: typeof meta.authenticate === 'function' ? 'present' : 'absent',
});

unitTest('no IdP configured mounts nothing', () => {
  expect(ssoRoutes({})).toEqual([]);
});

unitTest('each leg carries the meta the framework gives the built leg', async () => {
  const clock = frozenClock('2026-11-10T09:00:00.000Z');
  const idp = await fakeSamlIdentityProvider({
    audience: spEntityId(ORIGIN),
    clock,
    users: [{ nameId: 'u-ada', email: 'ada@acme.example' }],
  });
  const auth = postlyAuth({ adapter: memoryAuthAdapter(), clock, origin: ORIGIN });
  const built = postlySso(auth, {
    idpMetadataXml: idp.metadataXml,
    emailDomains: ['acme.example'],
  });

  expect(shape(START_META)).toEqual(shape(built.start.meta));
  expect(shape(ACS_META)).toEqual(shape(built.acs.meta));
  const routes = ssoRoutes({
    POSTLY_SSO_IDP_METADATA: idp.metadataXml,
    POSTLY_SSO_EMAIL_DOMAINS: 'acme.example',
  });
  expect(routes.map((route) => [route.method, route.path])).toEqual([
    [built.start.method, built.start.path],
    [built.acs.method, built.acs.path],
  ]);
});

unitTest('a bad IdP config fails the SSO legs with a logged code, never the mount', async () => {
  const env = { POSTLY_SSO_IDP_METADATA: '<not metadata/>', POSTLY_SSO_EMAIL_DOMAINS: '' };
  // Mounting is what `runtime.ts` does at import, in every role: it must not throw.
  const routes = ssoRoutes(env);
  const logged: string[] = [];
  const release = installLogSink((line) => {
    logged.push(line);
  });
  try {
    const server = httpServer({
      routes: [...routes],
      config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
    });
    const response = await server.fetch(new Request(`${ORIGIN}/auth/sso/corp`));

    expect(response.status).toBe(503);
    expect(((await response.json()) as { code?: unknown }).code).toMatch(/^X_[A-Z_]+$/);
    expect(logged.some((line) => line.includes('postly.sso.unavailable'))).toBe(true);
  } finally {
    release();
  }
});
