// A retirement has to reach the WIRE, not only the spec: before this there was no way to tell a
// mobile fleet that `listOrders` was going away, no `deprecated: true` in the operation, and no
// number to answer "is anyone still calling it?" — so the only options were breaking everyone at
// once or never removing anything.

import { describe, expect, test } from 'bun:test';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toOpenApiOperation, toRoute } from './http';

const Input = t.object({ orgId: t.string });
const Output = t.object({ ok: t.boolean });

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const retiring = (deprecated: { since: string; sunset: string; replacedBy?: string }) =>
  action({
    input: Input,
    output: Output,
    policy: allow(),
    deprecated,
    handle: () => ({ ok: true }),
  }).named('listOrders');

const call = (server: ReturnType<typeof createServer>, body: unknown = { orgId: 'o1' }) =>
  server.fetch(
    new Request('http://dev.test/api/orders/list', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );

const SINCE = '2026-08-01T00:00:00Z';
const SUNSET = '2026-12-31T23:59:59Z';

describe('a deprecated action announces itself on every response', () => {
  test('Deprecation and Sunset ride the 200', async () => {
    const server = createServer({
      routes: [toRoute(retiring({ since: SINCE, sunset: SUNSET }))],
      config: oneProcess(),
    });
    const response = await call(server);
    expect(response.status).toBe(200);
    // RFC 9745: a structured-field Date, `@` plus unix seconds — not an HTTP-date.
    expect(response.headers.get('deprecation')).toBe(`@${Date.parse(SINCE) / 1000}`);
    // RFC 8594: an IMF-fixdate — the other spelling of the same kind of instant.
    expect(response.headers.get('sunset')).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
  });

  test('the failure path carries them too — a stale caller is the one still 4xx-ing', async () => {
    // A handler-level failure, which is what this projection answers. A refusal raised by an
    // EARLIER pipeline stage (body, authz, rate limit) never reaches this handler and so carries
    // no sunset: those belong to `@ultimat3/http`, not to the action projection.
    const drifting = action({
      input: Input,
      output: Output,
      policy: allow(),
      deprecated: { since: SINCE, sunset: SUNSET },
      handle: () => ({ ok: 'yes' }) as unknown as { ok: boolean },
    }).named('listOrders');
    const server = createServer({ routes: [toRoute(drifting)], config: oneProcess() });
    const response = await call(server);
    expect(response.status).toBe(500);
    expect(response.headers.get('sunset')).toBe('Thu, 31 Dec 2026 23:59:59 GMT');
  });

  test('replacedBy becomes a successor link at the URL the client already derives', async () => {
    const server = createServer({
      routes: [toRoute(retiring({ since: SINCE, sunset: SUNSET, replacedBy: 'searchOrders' }))],
      config: oneProcess(),
    });
    const response = await call(server);
    expect(response.headers.get('link')).toBe('</api/orders/search>; rel="successor-version"');
  });

  test('an action that declares nothing sends nothing', async () => {
    const plain = action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: () => ({ ok: true }),
    }).named('listOrders');
    const server = createServer({ routes: [toRoute(plain)], config: oneProcess() });
    const response = await call(server);
    expect(response.headers.get('deprecation')).toBeNull();
    expect(response.headers.get('sunset')).toBeNull();
  });
});

describe('the spec says the same thing the wire does', () => {
  test('the operation is marked deprecated and carries the dates', () => {
    const operation = toOpenApiOperation(
      retiring({ since: SINCE, sunset: SUNSET, replacedBy: 'searchOrders' }),
    );
    expect(operation.deprecated).toBe(true);
    expect(operation['x-ultimate']['deprecation']).toEqual({
      since: '2026-08-01T00:00:00.000Z',
      sunset: '2026-12-31T23:59:59.000Z',
      replacedBy: 'searchOrders',
    });
  });

  test('an undeprecated operation omits the key entirely, so the spec bytes are unchanged', () => {
    const plain = action({
      input: Input,
      output: Output,
      policy: allow(),
      handle: () => ({ ok: true }),
    }).named('listOrders');
    expect('deprecated' in toOpenApiOperation(plain)).toBe(false);
    expect('deprecation' in toOpenApiOperation(plain)['x-ultimate']).toBe(false);
  });

  test('the descriptor publishes it, so `x actions list --json` can answer', () => {
    expect(retiring({ since: SINCE, sunset: SUNSET }).describe().deprecated).toEqual({
      since: SINCE,
      sunset: SUNSET,
    });
  });
});

describe('a date that cannot become a header is refused where it is declared', () => {
  test('the route projection refuses it, at mount and not on the first request', () => {
    expect(() => toRoute(retiring({ since: 'last tuesday', sunset: SUNSET }))).toThrow(
      /X_ACTION_DEPRECATION_INVALID/,
    );
  });

  test('the OpenAPI projection refuses the same value, so no spec publishes it', () => {
    expect(() => toOpenApiOperation(retiring({ since: SINCE, sunset: 'soon' }))).toThrow(
      /X_ACTION_DEPRECATION_INVALID/,
    );
  });
});
