// A tenant mount's document: the tenant is a required query parameter on every operation it
// serves, its absence a documented 400, and the listing a path of its own. Without `tenant`, the
// document is the one it was.

import { beforeEach, describe, expect, test } from 'bun:test';
import { MAX_TENANT_VALUE } from '@ultimat3/http';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { defineApi } from './define-api';
import { toRoute } from './http';
import { buildOpenApi } from './openapi';
import { mountOpenApi } from './openapi-complete';
import {
  TENANT_LISTING_COLLIDED_ID,
  TENANT_LISTING_OPERATION_ID,
  withTenantParameter,
} from './openapi-mount-tenant';
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
      // An app's own POST at the path the listing's GET is documented at.
      addTenant: action({
        input: t.object({ name: t.string }),
        output: t.object({ ok: t.boolean }),
        policy: can('tenants:add'),
        http: { path: '/tenants' },
        handle: () => ({ ok: true }),
      }),
      tenantsOfToken: action({
        input: t.object({}),
        output: t.object({ ok: t.boolean }),
        policy: can('tenants:read'),
        handle: () => ({ ok: true }),
      }),
    },
  });
});

const TENANT = { arg: 'org', resolve: () => null, list: () => [] };

const documentFor = (
  tenant: typeof TENANT | undefined,
  scopes: Readonly<Record<string, readonly string[]>> = { 'cases:write': ['createCase'] },
  rateLimit?: { readonly limit: number; readonly windowMs: number },
) =>
  mountOpenApi(buildOpenApi({ title: 'app', version: '0.1.0' }), {
    declared: {},
    mount: {
      prefix: '/v1',
      scopes,
      resolveToken: () => null,
      ...(tenant === undefined ? {} : { tenant }),
      ...(rateLimit === undefined ? {} : { rateLimit }),
    },
    routes: listActions().map(toRoute),
  });

type Op = {
  readonly operationId?: string;
  readonly parameters?: readonly {
    readonly name: string;
    readonly in: string;
    readonly required: boolean;
    readonly schema?: unknown;
  }[];
  readonly responses: Readonly<
    Record<string, { readonly description: string; readonly headers?: Record<string, unknown> }>
  >;
  readonly security?: unknown;
};
const op = (doc: ReturnType<typeof documentFor>, path: string, method = 'post'): Op =>
  (doc.paths[path] as Record<string, Op>)[method] as Op;

describe('mountOpenApi with tenant', () => {
  test('every served operation requires the tenant in the query string, and documents its 400', () => {
    const created = op(documentFor(TENANT), '/v1/cases/create');
    expect(created.parameters?.[0]).toMatchObject({ name: 'org', in: 'query', required: true });
    // The bounds the mount resolves a value within, in JSON Schema's own unit (code points).
    expect(created.parameters?.[0]?.schema).toEqual({
      type: 'string',
      minLength: 1,
      maxLength: MAX_TENANT_VALUE,
    });
    expect(created.responses['400']?.description).toContain('X_BEARER_TENANT_REQUIRED');
    // The action's own 400 is still named beside it.
    expect(created.responses['400']?.description).toContain('X_INPUT_INVALID');
    expect(created.responses['404']?.description).toContain('a tenant its person is not in');
    // A resolver that throws answers 500 on every tenant-scoped operation.
    expect(created.responses['500']?.description).toContain('X_BEARER_TENANT_UNRESOLVED');
  });

  test("the operation's own parameters survive, and its own tenant parameter keeps its schema", () => {
    const operation = {
      parameters: [
        { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
        { name: 'org', in: 'query', required: false, schema: { type: 'string', format: 'uuid' } },
      ],
      responses: { '500': { description: 'X_INTERNAL — the handler failed' } },
    };
    const projected = withTenantParameter(operation, 'org') as unknown as Op;
    expect(projected.parameters).toEqual([
      { name: 'org', in: 'query', required: true, schema: { type: 'string', format: 'uuid' } },
      { name: 'id', in: 'path', required: true, schema: { type: 'string' } },
      { name: 'q', in: 'query', required: false, schema: { type: 'string' } },
    ]);
    // A 500 the operation already documents keeps its words and gains the resolver's.
    expect(projected.responses['500']?.description).toBe(
      'X_INTERNAL — the handler failed; or X_BEARER_TENANT_UNRESOLVED — the tenant lookup failed',
    );
  });

  test('the listing is a bearer-secured GET of its own', () => {
    const listing = op(documentFor(TENANT), '/v1/tenants', 'get');
    expect(listing.security).toEqual([{ bearer: [] }]);
    expect(Object.keys(listing.responses).sort()).toEqual(['200', '401', '429', '500']);
    // The same challenge and Retry-After every other mounted operation documents.
    expect(Object.keys(listing.responses['401']?.headers ?? {})).toEqual(['WWW-Authenticate']);
    expect(Object.keys(listing.responses['429']?.headers ?? {})).toContain('Retry-After');
    expect(listing.responses['500']?.description).toContain('X_BEARER_TENANT_LIST_INVALID');
    expect(listing.responses['200']?.headers).toBeUndefined();
    // A listed value is documented within the bounds a call naming it is resolved for.
    expect(JSON.stringify(listing.responses['200'])).toContain(
      JSON.stringify({ type: 'string', minLength: 1, maxLength: MAX_TENANT_VALUE }),
    );
    const limited = op(
      documentFor(TENANT, undefined, { limit: 10, windowMs: 60_000 }),
      '/v1/tenants',
      'get',
    );
    expect(Object.keys(limited.responses['429']?.headers ?? {})).toContain('RateLimit-Remaining');
    // The mount's allowance is spent on every answer, so a 200 carries its headers too.
    expect(Object.keys(limited.responses['200']?.headers ?? {}).sort()).toEqual([
      'RateLimit-Limit',
      'RateLimit-Remaining',
      'RateLimit-Reset',
    ]);
  });

  test('the listing joins a mounted POST at the same path instead of replacing it', () => {
    const doc = documentFor(TENANT, {
      'cases:write': ['createCase'],
      'tenants:write': ['addTenant'],
    });
    const item = doc.paths['/v1/tenants'] as Record<string, Op>;
    expect(Object.keys(item).sort()).toEqual(['get', 'post']);
    expect(item['post']?.operationId).toBe('addTenant');
  });

  test('the listing keeps its operationId, tenantsOfToken, beside mounts that do not carry it', () => {
    const doc = documentFor(TENANT);
    expect(op(doc, '/v1/tenants', 'get').operationId).toBe('tenantsOfToken');
    expect(TENANT_LISTING_OPERATION_ID).toBe('tenantsOfToken');
  });

  test('a mounted primitive named tenantsOfToken keeps its id; the listing takes the one no primitive can', () => {
    const doc = documentFor(TENANT, { 'cases:write': ['createCase', 'tenantsOfToken'] });
    const ids = Object.values(doc.paths).flatMap((item) =>
      Object.values(item as Record<string, Op>).map((operation) => operation.operationId),
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('tenantsOfToken');
    expect(op(doc, '/v1/tenants', 'get').operationId).toBe(TENANT_LISTING_COLLIDED_ID);
    expect(TENANT_LISTING_COLLIDED_ID).toBe('tenants-of-token');
  });

  test('the scheme states that the listing needs no scope and names no tenant', () => {
    const schemeOf = (doc: ReturnType<typeof documentFor>): string =>
      String(
        (doc.components as { readonly securitySchemes?: Record<string, { description?: string }> })
          .securitySchemes?.['bearer']?.description,
      );
    const described = schemeOf(documentFor(TENANT));
    expect(described).toContain('GET /v1/tenants needs no scope and names no tenant');
    // The one-scope rule is the mounted primitives', so it cannot contradict the listing's.
    expect(described).toContain('Each mounted primitive operation lists the one scope');
    expect(described).not.toContain('Each operation lists');
    expect(schemeOf(documentFor(undefined))).not.toContain('/tenants');
  });

  test('a mount without tenant documents no tenant at all', () => {
    const doc = documentFor(undefined);
    expect(Object.keys(doc.paths)).toEqual(['/v1/cases/create']);
    expect(JSON.stringify(doc)).not.toContain('X_BEARER_TENANT_REQUIRED');
  });
});
