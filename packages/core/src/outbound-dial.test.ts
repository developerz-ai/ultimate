// The dial screen, alone and inside `outbound()`: one private address among public ones refuses, a
// literal is classified as itself, and a redirect hop is screened again. Measured over raw `fetch`:
// a default redirect from a screened name reached loopback (`secret-inner`).

import { describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { outbound } from './outbound';
import { publicUrlRefusal, screenDial } from './outbound-dial';
import { manualTimer, recordingFetch } from './outbound-fixture';

const resolving =
  (table: Readonly<Record<string, readonly string[]>>) =>
  async (hostname: string): Promise<readonly string[]> =>
    table[hostname] ?? [];

async function caught(work: Promise<unknown>): Promise<UltimateError> {
  try {
    await work;
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('the call answered');
}

describe('unit · screenDial', () => {
  test('one private address among public ones refuses, by class', async () => {
    const resolve = resolving({ 'api.test': ['93.184.216.34', '10.0.0.7'] });
    expect(await screenDial(new URL('https://api.test/x'), { resolve })).toEqual({
      refused: 'private',
    });
  });

  test('a public name is pinned to its first address, proving the name over TLS', async () => {
    const resolve = resolving({ 'api.test': ['93.184.216.34'] });
    expect(await screenDial(new URL('https://api.test:8443/x?q=1'), { resolve })).toEqual({
      pin: {
        url: 'https://93.184.216.34:8443/x?q=1',
        host: 'api.test:8443',
        serverName: 'api.test',
      },
    });
  });

  test('a literal address is classified as itself, never resolved', async () => {
    const resolve = (): Promise<readonly string[]> => expect.unreachable('resolved a literal');
    expect(await screenDial(new URL('http://[::1]/'), { resolve })).toEqual({
      refused: 'loopback',
    });
    expect(await screenDial(new URL('http://169.254.169.254/'), { resolve })).toEqual({
      refused: 'link-local',
    });
  });

  test('a name that does not resolve is unresolved, carrying the error; allowPrivate still pins', async () => {
    const failure = new TypeError('ENOTFOUND');
    const verdict = await screenDial(new URL('https://gone.test/'), {
      resolve: () => Promise.reject(failure),
    });
    expect(verdict).toMatchObject({ error: failure });
    expect(await screenDial(new URL('https://gone.test/'), { resolve: resolving({}) })).toEqual({
      unresolved: 'the host resolved to no address',
    });
    const inside = await screenDial(new URL('http://svc.internal/'), {
      resolve: resolving({ 'svc.internal': ['10.1.2.3'] }),
      allowPrivate: true,
    });
    expect(inside).toEqual({ pin: { url: 'http://10.1.2.3/', host: 'svc.internal' } });
  });

  test('a public URL is https outside local and carries no credentials', () => {
    expect(publicUrlRefusal(new URL('http://api.test/'), false)).toContain('not https:');
    expect(publicUrlRefusal(new URL('http://api.test/'), true)).toBeUndefined();
    expect(publicUrlRefusal(new URL('https://u:p@api.test/'), false)).toContain('credentials');
  });
});

describe('unit · outbound · public dial', () => {
  const env = { ULTIMATE_ENV: 'production' };

  test('a name resolving inward is X_OUTBOUND_HOST_BLOCKED and nothing is sent', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('secret-inner'));
    const error = await caught(
      outbound(
        { url: 'https://evil.test/', vendor: 'hook', dial: 'public', deadlineMs: 5_000 },
        { fetch, env, resolve: resolving({ 'evil.test': ['127.0.0.1'] }), timer: manualTimer() },
      ),
    );
    expect(error.code).toBe('X_OUTBOUND_HOST_BLOCKED');
    expect(calls).toHaveLength(0);
  });

  test('the pinned request carries the name as Host and as the TLS server name', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    await outbound(
      { url: 'https://api.test/v1', vendor: 'v', dial: 'public', deadlineMs: 5_000 },
      { fetch, env, resolve: resolving({ 'api.test': ['93.184.216.34'] }), timer: manualTimer() },
    );
    expect(calls[0]?.url).toBe('https://93.184.216.34/v1');
    expect(calls[0]?.init.tls).toEqual({ serverName: 'api.test' });
    expect(new Headers(calls[0]?.init.headers).get('host')).toBe('api.test');
  });

  test('a 3xx is X_OUTBOUND_REDIRECTED by default: the hop is never taken', async () => {
    const { fetch, calls } = recordingFetch(
      () => new Response('', { status: 302, headers: { location: 'https://other.test/a?k=1' } }),
    );
    const error = await caught(
      outbound(
        { url: 'https://api.test/', vendor: 'v', dial: 'named', deadlineMs: 5_000 },
        { fetch, timer: manualTimer() },
      ),
    );
    expect(error.code).toBe('X_OUTBOUND_REDIRECTED');
    expect(error.meta?.['location']).toBe('https://other.test/a');
    expect(calls).toHaveLength(1);
  });

  test("redirect: 'follow' re-screens the hop: a public name pointing at loopback is refused", async () => {
    const { fetch, calls } = recordingFetch(
      () => new Response('', { status: 302, headers: { location: 'http://inner.test/admin' } }),
    );
    const resolve = resolving({ 'api.test': ['93.184.216.34'], 'inner.test': ['127.0.0.1'] });
    const error = await caught(
      outbound(
        {
          url: 'https://api.test/',
          vendor: 'v',
          dial: 'public',
          deadlineMs: 5_000,
          redirect: 'follow',
        },
        { fetch, resolve, env: { ULTIMATE_ENV: 'development' }, timer: manualTimer() },
      ),
    );
    expect(error.code).toBe('X_OUTBOUND_HOST_BLOCKED');
    expect(calls).toHaveLength(1);
  });

  test('a followed cross-origin hop drops authorization and cookie; a 303 becomes a GET', async () => {
    const { fetch, calls } = recordingFetch((_call, n) =>
      n === 1
        ? new Response('', { status: 303, headers: { location: 'https://cdn.test/file' } })
        : new Response('done'),
    );
    const answer = await outbound(
      {
        url: 'https://api.test/upload',
        vendor: 'v',
        dial: 'named',
        deadlineMs: 5_000,
        method: 'POST',
        body: 'payload',
        redirect: 'follow',
        headers: {
          Authorization: 'Bearer t',
          Cookie: 'c=1',
          'Content-Type': 'text/plain',
          'X-Keep': '1',
        },
      },
      { fetch, timer: manualTimer(), resolve: resolving({ 'cdn.test': ['93.184.216.34'] }) },
    );
    expect(answer.text()).toBe('done');
    const second = calls[1]?.init;
    expect(second?.method).toBe('GET');
    expect(second?.body).toBeUndefined();
    // Another origin: only accept, content-type and user-agent travel — never a vendor's key header.
    expect(second?.headers).toEqual({ host: 'cdn.test' });
  });

  test('past five hops the chain is X_OUTBOUND_REDIRECTED', async () => {
    const { fetch, calls } = recordingFetch(
      (_call, n) => new Response('', { status: 307, headers: { location: `/hop/${n}` } }),
    );
    const error = await caught(
      outbound(
        {
          url: 'https://api.test/',
          vendor: 'v',
          dial: 'named',
          deadlineMs: 5_000,
          redirect: 'follow',
        },
        { fetch, timer: manualTimer(), resolve: resolving({ 'api.test': ['93.184.216.34'] }) },
      ),
    );
    expect(error.code).toBe('X_OUTBOUND_REDIRECTED');
    expect(calls).toHaveLength(6);
  });
});
