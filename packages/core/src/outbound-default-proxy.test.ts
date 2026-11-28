// The app-wide egress proxy: `outbound.proxy` in `app.config.ts`, installed once by the boot, is
// what every `outbound()` call with no `proxy` of its own goes through — a framework sender (APNs,
// FCM, OAuth) included, with no call-site change. A call's own `proxy` wins (a resolver answering
// `undefined` dials direct), loopback and the `direct` hosts never take the proxy, and its
// credential is printed nowhere.

import { afterEach, describe, expect, test } from 'bun:test';
import { isUltimateError, type UltimateError } from './errors';
import { resetInstrumentation } from './instrument';
import { installLogSink } from './logger';
import { outbound } from './outbound';
import {
  ambientProxyFor,
  configureOutboundProxy,
  isDirectHost,
  redactedProxyUrl,
} from './outbound-default-proxy';
import { manualTimer, recordingFetch } from './outbound-fixture';
import type { OutboundRequest } from './outbound-types';

const PROXY = 'http://user:s3cret@egress.internal:3128';
const releases: (() => void)[] = [];

afterEach(() => {
  for (const release of releases.splice(0)) release();
  resetInstrumentation();
});

function ambient(proxy: string | undefined, direct: readonly string[] = []): void {
  releases.push(configureOutboundProxy({ proxy, direct }));
}

const deps = (hosts: Readonly<Record<string, readonly string[]>> = {}) => ({
  env: { ULTIMATE_ENV: 'production' },
  resolve: (host: string): Promise<readonly string[]> => Promise.resolve(hosts[host] ?? []),
  timer: manualTimer(),
});

type BytesCall = OutboundRequest & { readonly read?: 'bytes' | undefined };
const call = (over: Partial<BytesCall> = {}): BytesCall => ({
  url: 'https://api.push.test/v1',
  vendor: 'apns',
  dial: 'named',
  deadlineMs: 5_000,
  ...over,
});

/** The `init.proxy` the transport was handed for one call, or `undefined` for a direct dial. */
async function proxiedAs(request: BytesCall) {
  const { fetch, calls } = recordingFetch(() => new Response('ok'));
  await outbound(request, { ...deps(), fetch });
  return calls[0]?.init.proxy;
}

describe('unit · outbound · the app-wide proxy', () => {
  test('unconfigured, a call with no proxy dials direct, as it always did', async () => {
    expect(await proxiedAs(call())).toBeUndefined();
  });

  test('configured, a call that says nothing goes through it — a framework sender unchanged', async () => {
    ambient(PROXY);
    expect(await proxiedAs(call())).toEqual({ url: `${PROXY}/` });
  });

  test('the public screen still runs first, then the hop rides the ambient proxy', async () => {
    ambient(PROXY);
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    const hosts = { 'api.push.test': ['93.184.216.34'] };
    await outbound(call({ dial: 'public' }), { ...deps(hosts), fetch });
    expect(calls[0]?.url).toBe('https://93.184.216.34/v1');
    expect(calls[0]?.init.proxy).toEqual({ url: `${PROXY}/` });
  });

  test("a call's own proxy wins, a URL or a resolver", async () => {
    ambient(PROXY);
    expect(await proxiedAs(call({ proxy: 'http://other.internal:8080' }))).toEqual({
      url: 'http://other.internal:8080/',
    });
    expect(await proxiedAs(call({ proxy: () => undefined }))).toBeUndefined();
  });

  test('a resolver answering undefined dials direct past a configured proxy', async () => {
    ambient(PROXY);
    expect(await proxiedAs(call({ proxy: () => undefined }))).toBeUndefined();
  });

  test('loopback and the declared direct hosts never take the proxy', async () => {
    ambient(PROXY, ['otel-collector.observability', 'cluster.local']);
    for (const url of [
      'http://localhost:4318/v1/traces',
      'http://api.localhost/x',
      'http://127.0.0.1:9000/x',
      'http://[::1]:9000/x',
      'http://otel-collector.observability:4318/v1/traces',
      'http://billing.svc.cluster.local/x',
    ]) {
      expect(await proxiedAs(call({ url }))).toBeUndefined();
    }
    // A suffix match is per label: `notcluster.local` is not under `cluster.local`.
    expect(await proxiedAs(call({ url: 'http://notcluster.local/x' }))).toEqual({
      url: `${PROXY}/`,
    });
  });

  test('isDirectHost: case-insensitive, per label, loopback always', () => {
    expect(isDirectHost('LOCALHOST', [])).toBe(true);
    expect(isDirectHost('127.8.9.10', [])).toBe(true);
    expect(isDirectHost('Vault.Internal', ['vault.internal'])).toBe(true);
    expect(isDirectHost('a.vault.internal', ['vault.internal'])).toBe(true);
    expect(isDirectHost('evilvault.internal', ['vault.internal'])).toBe(false);
    expect(isDirectHost('10.0.0.1', [])).toBe(false);
  });

  test('a socks5 ambient proxy is still refused by the hop, X_OUTBOUND_PROXY_INVALID', async () => {
    ambient('socks5://user:s3cret@egress.internal:1080');
    const { fetch, calls } = recordingFetch(() => new Response('ok'));
    let error: UltimateError | undefined;
    try {
      await outbound(call(), { ...deps(), fetch });
    } catch (thrown) {
      if (isUltimateError(thrown)) error = thrown;
    }
    expect(error?.code).toBe('X_OUTBOUND_PROXY_INVALID');
    expect(calls).toHaveLength(0);
    expect(`${error?.cause}${error?.fix}${JSON.stringify(error?.meta)}`).not.toContain('s3cret');
  });

  test('the boot line and every rendering name the proxy without its credential', () => {
    expect(redactedProxyUrl(PROXY)).toBe('http://***@egress.internal:3128');
    expect(redactedProxyUrl('https://egress.internal')).toBe('https://egress.internal');
    expect(redactedProxyUrl('not a url user:s3cret')).toBe('(not a URL)');
    const lines: string[] = [];
    const release = installLogSink((line) => lines.push(line));
    try {
      ambient(PROXY, ['vault.internal']);
    } finally {
      release();
    }
    const said = lines.join('\n');
    expect(said).toContain('egress.internal:3128');
    expect(said).toContain('vault.internal');
    expect(said).not.toContain('s3cret');
    expect(said).not.toContain('user:');
  });

  test('the release puts back what was there: a second boot starts unproxied', async () => {
    const release = configureOutboundProxy({ proxy: PROXY, direct: [] });
    release();
    expect(await proxiedAs(call())).toBeUndefined();
  });

  // The reader a raw transport (the AI providers, storage's signed S3 calls) asks instead of
  // `outbound()`: the same answer `prepare()` gets, for a named URL.
  test('ambientProxyFor answers the proxy for a URL, or undefined for none, loopback or direct', () => {
    expect(ambientProxyFor('https://api.anthropic.com/v1/messages')).toBeUndefined();
    ambient(PROXY, ['minio.storage']);
    expect(ambientProxyFor('https://api.anthropic.com/v1/messages')).toBe(PROXY);
    expect(ambientProxyFor(new URL('https://s3.eu-west-1.amazonaws.com/b/k'))).toBe(PROXY);
    expect(ambientProxyFor('http://localhost:9000/b/k')).toBeUndefined();
    expect(ambientProxyFor('http://minio.storage:9000/b/k')).toBeUndefined();
    expect(ambientProxyFor('not a url')).toBeUndefined();
  });

  // A plain-http target sent through the proxy crosses it in cleartext, Authorization or SigV4
  // included — an in-cluster gateway or MinIO left out of `outbound.direct`. Routing is unchanged
  // (the app may mean it); the first use per host says so once, naming the fix.
  test('a plain-http target the proxy carries warns once per host, naming outbound.direct', () => {
    ambient(PROXY, ['minio.storage']);
    const lines: string[] = [];
    const release = installLogSink((line) => lines.push(line));
    try {
      expect(ambientProxyFor('http://llm-gateway.svc:8080/v1/chat')).toBe(PROXY);
      expect(ambientProxyFor('http://llm-gateway.svc:8080/v1/other')).toBe(PROXY);
      expect(ambientProxyFor('https://api.openai.com/v1/chat')).toBe(PROXY);
      expect(ambientProxyFor('http://minio.storage:9000/b/k')).toBeUndefined();
      expect(ambientProxyFor('http://localhost:9000/b/k')).toBeUndefined();
    } finally {
      release();
    }
    const warned = lines.filter((line) => line.includes('cleartext'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('llm-gateway.svc');
    expect(warned[0]).toContain("outbound: { direct: ['llm-gateway.svc'] }");
    expect(warned[0]).not.toContain('s3cret');
    expect(warned[0]).not.toContain('/v1/chat');
  });
});
