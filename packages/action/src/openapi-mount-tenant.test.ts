// A tenant mount's document: the tenant is a required query parameter on every operation it
// serves, its absence a documented 400, and the listing a path of its own. Without `tenant`, the
// document is the one it was.

import { beforeEach, describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { defineApi } from './define-api';
import { toRoute } from './http';
import { buildOpenApi } from './openapi';
import { mountOpenApi } from './openapi-complete';
import { listActions, resetActions } from './registry';

beforeEach(() => {
  resetActions();
  defineApi({
    actions: {
      createCase: action({
        input: t.object({ title: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('cases:create'),
        handle: () => ({ ok: true }),
      }),
    },
  });
});

const TENANT = { arg: 'org', resolve: () => null, list: () => [] };

const documentFor = (tenant: typeof TENANT | undefined) =>
  mountOpenApi(buildOpenApi({ title: 'app', version: '0.1.0' }), {
    declared: {},
    mount: {
      prefix: '/v1',
      scopes: { 'cases:write': ['createCase'] },
      resolveToken: () => null,
      ...(tenant === undefined ? {} : { tenant }),
    },
    routes: listActions().map(toRoute),
  });

type Op = {
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
    readonly required: boolean;
  }[];
  readonly responses: Readonly<Record<string, { readonly description: string }>>;
  readonly security?: unknown;
};
const op = (doc: ReturnType<typeof documentFor>, path: string, method = 'post'): Op =>
  (doc.paths[path] as Record<string, Op>)[method] as Op;

describe('mountOpenApi with tenant', () => {
  test('every served operation requires the tenant in the query string, and documents its 400', () => {
    const created = op(documentFor(TENANT), '/v1/cases/create');
    expect(created.parameters?.[0]).toMatchObject({ name: 'org', in: 'query', required: true });
    expect(created.responses['400']?.description).toContain('X_BEARER_TENANT_REQUIRED');
    // The action's own 400 is still named beside it.
    expect(created.responses['400']?.description).toContain('X_INPUT_INVALID');
    expect(created.responses['404']?.description).toContain('a tenant its person is not in');
  });

  test('the listing is a bearer-secured GET of its own', () => {
    const listing = op(documentFor(TENANT), '/v1/tenants', 'get');
    expect(listing.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(listing.responses).sort()).toEqual(['200', '401']);
  });

  test('a mount without tenant documents no tenant at all', () => {
    const doc = documentFor(undefined);
    expect(Object.keys(doc.paths)).toEqual(['/v1/cases/create']);
    expect(JSON.stringify(doc)).not.toContain('X_BEARER_TENANT_REQUIRED');
  });
});
