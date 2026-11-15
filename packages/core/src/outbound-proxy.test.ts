// `outbound({ proxy })`'s init, per hop: a URL or a resolver asked with the hop's NAMED url, the
// dial screen before it, a bad proxy refused before a byte as a terminal code, and the proxy's
// credential absent from every cause, log line, span and event the call produces.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { resetInstrumentation, subscribe } from './instrument';
import { installLogSink } from './logger';
import { outbound } from './outbound';
import { manualTimer, recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';
import { alwaysOnSampler } from './sampler';
import { configureTelemetry, resetTelemetry } from './telemetry';

async function caught(work: Promise<unknown>): Promise<UltimateError> {
  try {
    await work;
  } catch (error) {
    if (isUltimateError(error)) return error;
    throw error;
  }
  return expect.unreachable('the call answered');
}

const env = { ULTIMATE_ENV: 'production' };
const resolving =
  (table: Readonly<Record<string, readonly string[]>>) =>
  (host: string): Promise<readonly string[]> =>
    Promise.resolve(table[host] ?? []);
const PROXY = 'http://user:s3cret@proxy.internal:3128';
type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const base = (over: Partial<BytesCall> = {}): BytesCall => ({
  url: 'https://api.test/v1',
  vendor: 'v',
  dial: 'public',
  deadlineMs: 5_000,
  ...over,
});
const deps = { env, resolve: resolving({ 'api.test': ['93.184.216.34'] }), timer: manualTimer() };

afterEach(() => {
  resetInstrumentation();
  resetTelemetry();
});

describe('unit · outbound · proxy', () => {
  test('a URL proxy rides the pinned hop beside the screened address and the TLS name', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    await outbound(base({ proxy: new URL(PROXY) }), { ...deps, fetch });
    expect(calls[0]?.url).toBe('https://93.184.216.34/v1');
    expect(calls[0]?.init.tls).toEqual({ serverName: 'api.test' });
    expect(calls[0]?.init.proxy).toEqual({ url: `${PROXY}/` });
  });

  test('the object form keeps its CONNECT headers', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const headers = { 'proxy-authorization': 'Bearer t' };
    await outbound(base({ proxy: { url: 'http://proxy.internal:3128', headers } }), {
      ...deps,
      fetch,
    });
    expect(calls[0]?.init.proxy).toEqual({ url: 'http://proxy.internal:3128/', headers });
  });

  test('no proxy, no proxy key: the platform default is left alone', async () => {
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    await outbound(base(), { ...deps, fetch });
    expect(calls[0]?.init).not.toHaveProperty('proxy');
  });

  test('a resolver is asked per hop with the NAMED url; undefined dials direct', async () => {
    const asked: string[] = [];
    const { fetch, calls } = recordingFetch((_call, n) =>
      n === 1
        ? new Response('', { status: 302, headers: { location: 'https://cdn.test/a' } })
        : new Response('ok'),
    );
    await outbound(
      base({
        redirect: 'follow',
        proxy: (target) => {
          asked.push(target.href);
          return target.hostname === 'api.test' ? PROXY : undefined;
        },
      }),
      {
        ...deps,
        fetch,
        resolve: resolving({ 'api.test': ['93.184.216.34'], 'cdn.test': ['93.184.216.35'] }),
      },
    );
    expect(asked).toEqual(['https://api.test/v1', 'https://cdn.test/a']);
    expect(calls[0]?.init.proxy).toEqual({ url: `${PROXY}/` });
    expect(calls[1]?.init).not.toHaveProperty('proxy');
  });

  test('the screen runs first: a private answer is refused and the resolver never asked', async () => {
    let asked = 0;
    const { fetch, calls } = recordingFetch(() => new Response('inner'));
    const error = await caught(
      outbound(
        base({
          proxy: () => {
            asked += 1;
            return PROXY;
          },
        }),
        { ...deps, fetch, resolve: resolving({ 'api.test': ['10.0.0.5'] }) },
      ),
    );
    expect([error.code, asked, calls.length]).toEqual(['X_OUTBOUND_HOST_BLOCKED', 0, 0]);
  });

  test.each([
    ['not a URL', 'proxy.internal:3128 please'],
    ['a socks URL', 'socks5://user:s3cret@proxy.internal:1080'],
    ['a file URL', 'file:///etc/passwd'],
  ])('%s is X_OUTBOUND_PROXY_INVALID before a byte, never retried', async (_label, proxy) => {
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const error = await caught(
      outbound(base({ proxy, retry: { attempts: 3, base: 0, max: 0, jitter: 'none' } }), {
        ...deps,
        fetch,
        sleep: async () => {},
      }),
    );
    expect([error.code, error.retry, calls.length]).toEqual([
      'X_OUTBOUND_PROXY_INVALID',
      'terminal',
      0,
    ]);
    expect(`${error.cause}${error.fix}${JSON.stringify(error.meta)}`).not.toContain('s3cret');
  });

  test('a resolver that throws is X_OUTBOUND_PROXY_INVALID, its error kept as the source', async () => {
    const boom = new TypeError('inventory empty');
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const error = await caught(
      outbound(
        base({
          proxy: () => {
            throw boom;
          },
        }),
        { ...deps, fetch },
      ),
    );
    expect([error.code, calls.length]).toEqual(['X_OUTBOUND_PROXY_INVALID', 0]);
    expect(error.sourceError).toBe(boom);
  });

  test('the credential is in no cause, log line, span or event, even when the transport quotes it', async () => {
    configureTelemetry({ sampler: alwaysOnSampler });
    const seen: string[] = [];
    subscribe('outbound.request', (event) => seen.push(JSON.stringify(event.payload)));
    subscribe('span.end', (event) => seen.push(JSON.stringify(event.payload.attributes)));
    const lines: string[] = [];
    const release = installLogSink((line) => lines.push(line));
    const quoting = new TypeError(`ECONNREFUSED dialling ${PROXY} for https://93.184.216.34/v1`);
    const { fetch } = recordingFetch(() => {
      throw quoting;
    });
    let error: UltimateError;
    try {
      error = await caught(
        outbound(base({ proxy: PROXY, retry: { attempts: 1, base: 0, max: 0, jitter: 'none' } }), {
          ...deps,
          fetch,
        }),
      );
    } finally {
      release();
    }
    expect(error.code).toBe('X_OUTBOUND_UNREACHABLE');
    const everything = [error.cause, error.fix, JSON.stringify(error.meta), ...seen, ...lines].join(
      '\n',
    );
    expect(everything).toContain('proxy.internal');
    expect(everything).not.toContain('s3cret');
  });

  test('a resolver that never answers is still bounded by deadlineMs', async () => {
    const timer = manualTimer();
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const pending = caught(
      outbound(
        base({
          proxy: () => new Promise<undefined>(() => {}),
          deadlineMs: 900,
          retry: { attempts: 1, base: 0, max: 0, jitter: 'none' },
        }),
        {
          ...deps,
          fetch,
          timer,
          now: () => 5_000,
        },
      ),
    );
    await timer.armedWith(900);
    timer.fire(900);
    const error = await pending;
    expect([error.code, error.meta?.['phase'], calls.length]).toEqual([
      'X_OUTBOUND_TIMEOUT',
      'deadline',
      0,
    ]);
  });
});
