import { afterEach, describe, expect, test } from 'bun:test';
import { markListening, resetListeners } from '@ultimat3/core';
import { allowHost, mockJson, requestedUrls, resetNetwork, sealNetwork } from './sealed-network';

sealNetwork();

afterEach(() => {
  resetNetwork();
  resetListeners();
});

/** The seal throws; anything else means the request left this file. Never resolves to a Response. */
const refusalOf = async (url: string): Promise<{ code?: string } | undefined> =>
  fetch(url).then(
    () => undefined,
    (error: unknown) => error as { code?: string },
  );

describe('unit · sealed network', () => {
  test('an unmocked request fails with the URL and the line that fixes it', async () => {
    try {
      await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
      throw new Error('expected the sealed network to refuse this');
    } catch (error) {
      const failure = error as { code?: string; cause?: string; fix?: string };
      expect(failure.code).toBe('X_TEST_NETWORK_SEALED');
      expect(failure.cause).toContain('POST https://api.stripe.com/v1/charges');
      expect(failure.fix).toContain("mockFetch('https://api.stripe.com/v1/charges'");
      expect(failure.fix).toContain("allowHost('api.stripe.com')");
    }
  });

  test('a mocked request is answered without touching the network', async () => {
    mockJson('https://api.stripe.com/v1/charges', { id: 'ch_1' });
    const response = await fetch('https://api.stripe.com/v1/charges', { method: 'POST' });
    expect(await response.json()).toEqual({ id: 'ch_1' });
  });

  test('a prefix mock covers a whole path', async () => {
    mockJson('https://api.example.com/*', { ok: true });
    expect(await (await fetch('https://api.example.com/a/b/c')).json()).toEqual({ ok: true });
  });

  test('a regexp mock matches on the whole URL', async () => {
    mockJson(/\/v1\/customers\/[a-z0-9]+$/, { id: 'cus_1' });
    expect(await (await fetch('https://api.example.com/v1/customers/abc')).json()).toEqual({
      id: 'cus_1',
    });
  });

  test('the failure names the hosts that are allowed, so the fix is obvious', async () => {
    allowHost('allowed.example.com');
    try {
      await fetch('https://blocked.example.com/x');
      throw new Error('expected a refusal');
    } catch (error) {
      expect((error as { cause?: string }).cause).toContain('allowed.example.com');
    }
  });

  test('a port this process opened is not egress — the seal lets it through', async () => {
    const release = markListening('http://127.0.0.1:59321');
    // Nothing is listening, so this must fail — but as a connection error, not as the seal.
    expect((await refusalOf('http://localhost:59321/healthz'))?.code).not.toBe(
      'X_TEST_NETWORK_SEALED',
    );
    release();
    expect((await refusalOf('http://localhost:59321/healthz'))?.code).toBe('X_TEST_NETWORK_SEALED');
  });

  test('every attempted URL is recorded, in order', async () => {
    mockJson('https://a.example.com/1', {});
    mockJson('https://a.example.com/2', {});
    await fetch('https://a.example.com/1');
    await fetch('https://a.example.com/2');
    expect(requestedUrls()).toEqual(['https://a.example.com/1', 'https://a.example.com/2']);
  });
});
