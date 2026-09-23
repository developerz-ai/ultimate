// A server-side typed call whose answer is in THIS process — the build's measurement render, which
// has no server to reach — goes through the dispatcher the scope names, and nowhere else.
import { describe, expect, test } from 'bun:test';
import { clientTransport } from './client-transport';
import { fakeFetch } from './client-transport-fixture';
import { withInProcessFetch } from './in-process-fetch';

const json = (value: unknown): Response =>
  new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

describe('unit · the in-process dispatch scope', () => {
  test('inside the scope a read is answered by the dispatcher, with the url and init it was sent', async () => {
    const inProcess = fakeFetch(() => json({ rows: 3 }));
    const answer = await withInProcessFetch(inProcess.fetchImpl, () =>
      clientTransport({ method: 'GET', url: 'http://app.invalid/_x/query/feed?limit=3' }),
    );
    expect(answer).toEqual({ rows: 3 });
    expect(inProcess.calls.map((call) => [call.url, call.init.method])).toEqual([
      ['http://app.invalid/_x/query/feed?limit=3', 'GET'],
    ]);
  });

  test('the scope ends with its callback: a call after it does not reach the dispatcher', async () => {
    const inProcess = fakeFetch(() => json(1));
    await withInProcessFetch(inProcess.fetchImpl, async () => undefined);
    const wire = fakeFetch(() => json(2));
    expect(
      await clientTransport<number>({
        method: 'GET',
        url: 'http://a.invalid/',
        fetchImpl: wire.fetchImpl,
      }),
    ).toBe(2);
    expect(inProcess.calls).toEqual([]);
  });

  test('outside a scope the wrapped fetch answers — here, the sealed test network refusing', async () => {
    await withInProcessFetch(fakeFetch(() => json(1)).fetchImpl, async () => undefined);
    const refused = await fetch('http://outside.invalid/').catch((e: unknown) => e);
    expect(refused).toBeUltimateError('X_TEST_NETWORK_SEALED');
  });

  test("a caller's own fetchImpl still wins inside the scope", async () => {
    const inProcess = fakeFetch(() => json('scope'));
    const own = fakeFetch(() => json('own'));
    const answer = await withInProcessFetch(inProcess.fetchImpl, () =>
      clientTransport({
        method: 'POST',
        url: 'http://a.invalid/',
        body: {},
        fetchImpl: own.fetchImpl,
      }),
    );
    expect(answer).toBe('own');
    expect(inProcess.calls).toEqual([]);
  });
});
