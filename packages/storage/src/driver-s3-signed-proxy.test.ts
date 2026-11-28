// Storage's signed S3 requests (metadata PUTs, object lock, ranged reads, multipart, copies) go out
// with their own `fetch`, so the app-wide egress proxy reaches them through core's reader: on an
// egress-locked deploy they reach AWS through `outbound.proxy`, while an in-cluster endpoint (a
// MinIO named in `outbound.direct`, or loopback) is dialled direct.
import { afterEach, describe, expect, test } from 'bun:test';
import { configureOutboundProxy } from '@ultimat3/core/outbound';
import { FAKE_ENV } from './driver-s3-fixture';
import { type S3FetchLike, sendSigned } from './driver-s3-signed';

const PROXY = 'http://user:s3cret@egress.internal:3128';
const releases: (() => void)[] = [];
afterEach(() => {
  for (const release of releases.splice(0)) release();
});

/** The `init.proxy` one signed GET handed its transport, `'none'` when it set no key. */
async function proxyOf(endpoint?: string): Promise<unknown> {
  const seen: unknown[] = [];
  const fetch: S3FetchLike = (_url, init) => {
    seen.push('proxy' in init ? init.proxy : 'none');
    return Promise.resolve(new Response('ok'));
  };
  await sendSigned(
    {
      bucket: 'b',
      region: 'eu-west-1',
      env: FAKE_ENV,
      fetch,
      ...(endpoint === undefined ? {} : { endpoint, forcePathStyle: true }),
    },
    { method: 'GET', key: 'k' },
  );
  return seen[0];
}

describe('unit · the s3 disk honours the app-wide egress proxy', () => {
  test('no proxy installed: the signed request carries no proxy key, as before', async () => {
    expect(await proxyOf()).toBe('none');
  });

  test('installed: a signed request to AWS goes through it', async () => {
    releases.push(configureOutboundProxy({ proxy: PROXY }));
    expect(await proxyOf()).toBe(PROXY);
  });

  test('an in-cluster or loopback endpoint dials direct', async () => {
    releases.push(configureOutboundProxy({ proxy: PROXY, direct: ['minio.storage'] }));
    expect(await proxyOf('http://minio.storage:9000')).toBe('none');
    expect(await proxyOf('http://127.0.0.1:9000')).toBe('none');
  });
});

// 31.51.0's `S3FetchLike` had no `proxy`: a transport an app typed by that init still compiles as
// one (a new optional property makes its parameter a supertype) and still sends — it is simply
// handed one more key it may ignore.
describe('unit · an S3FetchLike written against 31.51.0', () => {
  test('typed by the recorded init, it is still an S3FetchLike', async () => {
    const methods: string[] = [];
    const recorded = (
      _url: string,
      init: {
        readonly method: string;
        readonly headers: Readonly<Record<string, string>>;
        readonly body?: Uint8Array<ArrayBuffer> | undefined;
      },
    ): Promise<Response> => {
      methods.push(init.method);
      return Promise.resolve(new Response('ok'));
    };
    const fetch: S3FetchLike = recorded;
    releases.push(configureOutboundProxy({ proxy: PROXY }));
    await sendSigned(
      { bucket: 'b', region: 'eu-west-1', env: FAKE_ENV, fetch },
      { method: 'GET', key: 'k' },
    );
    expect(methods).toEqual(['GET']);
  });
});
