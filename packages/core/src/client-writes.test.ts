// The "a write went through" signal the client router's cache clears on. Pinned: it fires AFTER
// the write settles — failed or not — and one listener's throw never fails the write or the others.
import { afterEach, describe, expect, test } from 'bun:test';
import { notifyClientWrite, onClientWrite } from './client-writes';

const offs: (() => void)[] = [];
afterEach(() => {
  for (const off of offs.splice(0)) off();
});

describe('onClientWrite', () => {
  test('every listener hears every write, even after one throws', () => {
    const heard: string[] = [];
    offs.push(
      onClientWrite(() => {
        throw new TypeError('a broken cache');
      }),
      onClientWrite((url) => heard.push(url)),
    );
    expect(() => notifyClientWrite('/api/casos/create')).not.toThrow();
    expect(heard).toEqual(['/api/casos/create']);
  });

  test('unsubscribed is silent', () => {
    const heard: string[] = [];
    const off = onClientWrite((url) => heard.push(url));
    off();
    notifyClientWrite('/api/x');
    expect(heard).toEqual([]);
  });

  test('one listener set per page, whatever copy of core registered it', () => {
    const key = Symbol.for('ultimate.client-writes');
    offs.push(onClientWrite(() => undefined));
    expect((globalThis as unknown as Record<symbol, Set<unknown>>)[key]?.size).toBeGreaterThan(0);
  });
});

describe('clientTransport announces its writes', () => {
  test('a write is announced after it settles, a failed one too; a read never is', async () => {
    const { clientTransport } = await import('./client-transport');
    const { fakeFetch, json } = await import('./client-transport-fixture');
    const heard: string[] = [];
    offs.push(onClientWrite((url) => heard.push(url)));
    const ok = fakeFetch(() => json({ ok: true }));
    await clientTransport({ method: 'GET', url: '/_x/query/a', fetchImpl: ok.fetchImpl });
    expect(heard).toEqual([]);
    await clientTransport({ method: 'POST', url: '/api/a', body: {}, fetchImpl: ok.fetchImpl });
    expect(heard).toEqual(['/api/a']);
    const broken = fakeFetch(() => json({ code: 'X_BOOM', cause: 'c', fix: 'f' }, { status: 500 }));
    await clientTransport({
      method: 'POST',
      url: '/api/b',
      body: {},
      fetchImpl: broken.fetchImpl,
    }).catch(() => undefined);
    expect(heard).toEqual(['/api/a', '/api/b']);
    Reflect.deleteProperty(globalThis, Symbol.for('ultimate.client'));
  });
});
