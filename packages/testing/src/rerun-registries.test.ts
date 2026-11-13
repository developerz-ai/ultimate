// Each framework registry the rerun seam reads, over its owning package's real lister and
// restore: a forgotten name declares afresh, a name kept is still refused, and only a package
// already loaded is read.

import { afterEach, describe, expect, test } from 'bun:test';
import { action, listActions } from '@ultimat3/action';
import { registerActions, restoreActions } from '@ultimat3/action/loader';
import {
  type OAuthProvider,
  registeredOAuthProviders,
  registerOAuthProvider,
  restoreOAuthProviders,
} from '@ultimat3/auth';
import { defineService, registeredServices, restoreServices } from '@ultimat3/core';
import { entity, registeredEntities, text, uuid } from '@ultimat3/entity';
import { job, registeredJobs, restoreJobs } from '@ultimat3/jobs';
import {
  blocks,
  defineMail,
  layoutFor,
  registeredMails,
  registerLayout,
  restoreMails,
} from '@ultimat3/mail';
import { allow } from '@ultimat3/policy';
import { from, listQueries, query } from '@ultimat3/query';
import { registerQueries } from '@ultimat3/query/loader';
import { t } from '@ultimat3/schema';
import type { DeclarationRegistry } from './rerun-declarations';
import { frameworkDeclarationRegistries } from './rerun-registries';

const held = {
  actions: listActions(),
  jobs: registeredJobs(),
  queries: listQueries(),
  mails: registeredMails(),
  oauth: registeredOAuthProviders(),
  services: registeredServices(),
};
afterEach(() => {
  restoreActions(held.actions);
  restoreJobs(held.jobs);
  restoreMails(held.mails);
  restoreOAuthProviders(held.oauth);
  restoreServices(held.services);
});

const registry = (kind: string): DeclarationRegistry => {
  const found = frameworkDeclarationRegistries().find((entry) => entry.kind === kind);
  if (found === undefined) expect.unreachable(`no ${kind} registry`);
  return found;
};

/** Forget `name`, declare it again, then put the forgotten entry back over the redeclaration. */
const roundTrip = (kind: string, name: string, declare: () => unknown): void => {
  declare();
  const forgotten = registry(kind).forget(new Set([name]));
  expect(forgotten).toHaveLength(1);
  expect(registry(kind).names()).not.toContain(name);
  expect(declare).not.toThrow();
  // Declared again, so putting the old entry back leaves the new one alone…
  registry(kind).putBack(forgotten);
  expect(
    registry(kind)
      .names()
      .filter((entry) => entry === name),
  ).toHaveLength(1);
  // …and the duplicate refusal stands.
  expect(declare).toThrow();
};

const bigco: OAuthProvider = {
  id: 'rerun-probe-sso',
  authorizeUrl: 'https://sso.rerun.test/authorize',
  tokenUrl: 'https://sso.rerun.test/token',
  userInfoUrl: 'https://sso.rerun.test/userinfo',
  userEmailsUrl: null,
  issuers: ['https://sso.rerun.test'],
  jwksUri: 'https://sso.rerun.test/keys',
  scopes: ['openid'],
  usesPkce: true,
  usesNonce: true,
  clientIdEnv: 'RERUN_PROBE_CLIENT_ID',
  clientSecretEnv: 'RERUN_PROBE_CLIENT_SECRET',
};

describe('frameworkDeclarationRegistries', () => {
  test('every registry a framework file declares into, once its package is loaded', () => {
    expect(frameworkDeclarationRegistries().map((entry) => entry.kind)).toEqual([
      'job',
      'service',
      'entity',
      'action',
      'query',
      'mail',
      'mail-layout',
      'oauth-provider',
    ]);
  });

  test('actions', () => {
    roundTrip('action', 'rerunProbe', () =>
      registerActions({
        rerunProbe: action({
          input: t.object({}),
          output: t.object({}),
          policy: allow(),
          handle: () => ({}),
        }),
      }),
    );
  });

  test('queries', () => {
    roundTrip('query', 'rerunProbeRows', () =>
      registerQueries({
        rerunProbeRows: query({
          input: t.object({}),
          policy: allow(),
          sql: () => from<{ id: string }>('rerun_probe_rows', []),
        }),
      }),
    );
    registry('query').forget(new Set(['rerunProbeRows']));
    expect(listQueries().map((entry) => entry.name)).toEqual(held.queries.map((q) => q.name));
  });

  test('mails', () => {
    roundTrip('mail', 'rerun-probe', () =>
      defineMail<Record<string, never>>({
        id: 'rerun-probe',
        input: t.object({}),
        subject: 'test.rerun.subject',
        template: () => [blocks.paragraph('test.rerun.body')],
      }),
    );
  });

  test('mail layouts', () => {
    roundTrip('mail-layout', 'rerun-probe-layout', () =>
      registerLayout('rerun-probe-layout', () => '<probe/>'),
    );
    registry('mail-layout').forget(new Set(['rerun-probe-layout']));
  });

  test('oauth providers', () => {
    roundTrip('oauth-provider', bigco.id, () => registerOAuthProvider(bigco));
  });

  test('jobs', () => {
    roundTrip('job', 'rerunProbe', () =>
      job({
        tenant: 'none',
        name: 'rerunProbe',
        input: t.object({}),
        idempotencyKey: () => 'rerun-probe',
        retry: { attempts: 1 },
        run: () => Promise.resolve(),
      }),
    );
  });

  test('services', () => {
    roundTrip('service', 'rerunProbe', () => defineService('rerunProbe', () => ({})));
  });

  test('entities', () => {
    roundTrip('entity', 'rerun_probe_rows', () =>
      entity('rerun_probe_rows', { columns: { id: uuid().primaryKey(), body: text() } }),
    );
    registry('entity').forget(new Set(['rerun_probe_rows']));
    expect(registeredEntities().map((entry) => entry.name)).not.toContain('rerun_probe_rows');
  });

  test('what a declaring module exports is recognised as its declaration, and nothing else is', () => {
    // The rerun seam keeps a name a lazily imported module declared only when this answers yes.
    const notes = entity('rerun_probe_exported', { columns: { id: uuid().primaryKey() } });
    const charge = action({
      input: t.object({}),
      output: t.object({}),
      policy: allow(),
      handle: () => ({}),
    });
    registerActions({ rerunProbeCharge: charge });
    const factory = (): object => ({});
    defineService('rerunProbeExported', factory);
    registerOAuthProvider(bigco);
    const exports: readonly [string, string, unknown][] = [
      ['entity', 'rerun_probe_exported', notes],
      ['action', 'rerunProbeCharge', charge],
      ['service', 'rerunProbeExported', factory],
      ['mail-layout', 'base', layoutFor('base')],
      // The registry holds a sealed copy; the module exports the object it was handed.
      ['oauth-provider', bigco.id, bigco],
    ];
    for (const [kind, name, value] of exports) {
      expect([kind, registry(kind).exported(name, ['unrelated', value])]).toEqual([kind, true]);
      expect([kind, registry(kind).exported(name, ['unrelated', {}])]).toEqual([kind, false]);
    }
    registry('entity').forget(new Set(['rerun_probe_exported']));
  });
});
