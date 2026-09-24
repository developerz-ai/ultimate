// `bodyBytes()` and `useRequestBodyBytes()`: the exact body, for a signature over the raw bytes.
// Split from `request.test.ts` at its line ceiling; the build and capture helpers are its own.
import { describe, expect, test } from 'bun:test';
import { createContext, runWithContext } from '@ultimat3/core';
import { defineHttpConfig, type HttpConfigInput } from './config';
import { asCtx, createRequestContext, useRequestBodyBytes } from './context';
import { HttpError } from './errors';
import { UltimateRequest } from './request';

const build = (
  urlString: string,
  requestInit: RequestInit = {},
  configInput: HttpConfigInput = {},
) => {
  const url = new URL(urlString);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' }, ...configInput });
  const ctx = createRequestContext({
    url,
    method: (requestInit.method ?? 'GET').toString(),
    role: 'web',
    config,
  });
  return { req: new UltimateRequest(new Request(url, requestInit), ctx), ctx };
};

const captureError = async (run: () => Promise<unknown>): Promise<HttpError | undefined> => {
  try {
    await run();
  } catch (error) {
    if (error instanceof HttpError) return error;
    throw error;
  }
  return undefined;
};

describe('bodyBytes() — the exact bytes, one read', () => {
  // A trailing CRLF, a BOM and a byte that is not UTF-8: every one of them is lost or rewritten
  // by a decode, and a signature over the body (SNS, a payment gateway) is over these bytes.
  const sent = new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d, 0xff, 0x0d, 0x0a]);

  test('a text/plain body comes back byte for byte', async () => {
    const { req } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain; charset=UTF-8' },
      body: sent,
    });
    expect(await req.bodyBytes()).toEqual(sent);
  });

  test('bodyRaw() after bodyBytes() parses the same cached bytes, and the reverse', async () => {
    const first = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"a":1}',
    });
    expect(new TextDecoder().decode(await first.req.bodyBytes())).toBe('{"a":1}');
    expect(await first.req.bodyRaw()).toEqual({ a: 1 });

    const second = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: sent,
    });
    expect(typeof (await second.req.bodyRaw())).toBe('string');
    expect(await second.req.bodyBytes()).toEqual(sent);
  });

  test('any content type is readable as bytes — only bodyRaw() dispatches on it', async () => {
    const { req } = build('https://example.com/x', {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: new Uint8Array([1, 2, 3]),
    });
    expect(await req.bodyBytes()).toEqual(new Uint8Array([1, 2, 3]));
  });

  test('GET has no bytes, and the size cap still refuses', async () => {
    expect((await build('https://example.com/x').req.bodyBytes()).byteLength).toBe(0);
    const { req } = build(
      'https://example.com/x',
      { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x'.repeat(64) },
      { bodyLimitBytes: 8 },
    );
    expect((await captureError(() => req.bodyBytes()))?.code).toBe('X_BODY_INVALID');
  });

  test('useRequestBodyBytes() reads the in-scope request — what an action handler calls', async () => {
    const { req, ctx } = build('https://example.com/x', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: sent,
    });
    await req.bodyRaw();
    expect(await runWithContext(asCtx(ctx), () => useRequestBodyBytes())).toEqual(sent);
  });

  test('useRequestBodyBytes() off a request (a job, a task) is X_NO_REQUEST', () => {
    expect(() => runWithContext(createContext({}), () => useRequestBodyBytes())).toThrow(
      /X_NO_REQUEST/,
    );
  });
});
