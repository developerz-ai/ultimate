// A keyed action served over HTTP is still a request. `runToCompletion` gives it a fresh signal, and
// a plain rebuilt context dropped the request's fields: `useRequestHeader()` answered `X_NO_REQUEST`
// where the same action with no key answered, and the failure was SETTLED, so the retry replayed it
// for the whole window. Over the real pipeline: one body, keyed and unkeyed, must agree.

import { afterEach, describe, expect, test } from 'bun:test';
import { useContext } from '@ultimat3/core';
import {
  defineHttpConfig,
  httpServer,
  setCookie,
  setRedirect,
  useRequestHeader,
} from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { resetIdempotency } from './adapter';
import { toRoute } from './http';

afterEach(() => resetIdempotency());

const serve = (handle: () => unknown) =>
  httpServer({
    routes: [
      toRoute(
        action({
          input: t.object({ n: t.number }),
          output: t.object({ seen: t.string }),
          policy: allow(),
          idempotent: true,
          handle: handle as () => { seen: string },
        }).named('createProbe'),
      ),
    ],
    config: defineHttpConfig({ rateLimit: { scope: 'process' } }),
  });

const post = (server: ReturnType<typeof serve>, key: string | null): Promise<Response> =>
  server.fetch(
    new Request('http://dev.test/api/probes/create', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'probe',
        ...(key === null ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify({ n: 1 }),
    }),
  );

for (const [name, key] of [
  ['unkeyed', null],
  ['keyed', 'k-1'],
] as const) {
  describe(`a ${name} action over HTTP`, () => {
    test('reads a request header', async () => {
      const response = await post(
        serve(() => ({ seen: useRequestHeader('user-agent') ?? 'nothing' })),
        key,
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ seen: 'probe' });
    });

    test('its setCookie reaches the response', async () => {
      const response = await post(
        serve(() => {
          setCookie('probe', 'yes');
          return { seen: 'cookie' };
        }),
        key,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('set-cookie')).toContain('probe=yes');
    });

    test('its setRedirect is read back', async () => {
      const response = await post(
        serve(() => {
          setRedirect('/feed');
          return { seen: 'redirect' };
        }),
        key,
      );
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/feed');
    });

    test('the handler ctx carries the request fields, and a live signal', async () => {
      const response = await post(
        serve(() => {
          const ctx = useContext();
          const fields = ctx as unknown as { method?: string; headers?: Headers };
          return {
            seen: `${fields.method} ${fields.headers instanceof Headers} ${ctx.signal.aborted}`,
          };
        }),
        key,
      );
      expect(await response.json()).toEqual({ seen: 'POST true false' });
    });
  });
}
