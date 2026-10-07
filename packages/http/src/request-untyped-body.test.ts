// A body with no `content-type` used to parse as "no body": `bodyRaw()` answered `undefined` for
// `{"a":1}` sent bare, so a schema whose fields are all optional validated a request it never read.
// Bytes nobody declared a type for are refused; only a body that is really absent is `undefined`.
import { describe, expect, test } from 'bun:test';
import { defineHttpConfig } from './config';
import { requestContext } from './context';
import { httpPipeline } from './pipeline';
import { UltimateRequest } from './request';
import { jsonResponse } from './response';
import { httpRouter } from './router';
import type { Schema } from './validate';

const untyped = (
  body: Uint8Array<ArrayBuffer> | null,
  headers: Record<string, string> = {},
): UltimateRequest => {
  const url = new URL('https://example.com/x');
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({ url, method: 'POST', role: 'web', config });
  return new UltimateRequest(new Request(url, { method: 'POST', body, headers }), ctx);
};

const bytes = Uint8Array.from(new TextEncoder().encode('{"a":1}'));

describe('bodyRaw() — bytes with no declared type', () => {
  test('are X_BODY_INVALID, naming the missing header and never the bytes', async () => {
    try {
      await untyped(bytes).bodyRaw();
      expect.unreachable('an undeclared body was read as no body');
    } catch (error) {
      const refusal = error as { code?: string; cause?: string };
      expect(refusal.code).toBe('X_BODY_INVALID');
      expect(refusal.cause).toContain('content-type');
      expect(refusal.cause).not.toContain('"a"');
    }
  });

  test('the neighbours: no body, an empty body and a declared zero length stay undefined', async () => {
    expect(await untyped(null).bodyRaw()).toBeUndefined();
    expect(await untyped(new Uint8Array(0)).bodyRaw()).toBeUndefined();
    expect(await untyped(null, { 'content-length': '0' }).bodyRaw()).toBeUndefined();
  });

  test('the raw bytes are still readable — a signed upload declares no type', async () => {
    expect(await untyped(bytes).bodyBytes()).toEqual(bytes);
  });

  test('through the body stage, an all-optional schema no longer validates what it never read', async () => {
    const optional: Schema<{ a?: number }> = {
      '~standard': {
        version: 1,
        vendor: 'ultimate-test',
        validate: (value: unknown) => ({ value: (value ?? {}) as { a?: number } }),
      },
    };
    const pipeline = httpPipeline({
      table: httpRouter([
        {
          method: 'POST',
          path: '/x',
          meta: { name: 'x', auth: 'public', input: optional },
          handler: (_request, ctx) => jsonResponse({ input: ctx.input }),
        },
      ]),
      config: defineHttpConfig({ rateLimit: { scope: 'process' }, dev: false, buildId: null }),
    });
    const response = await pipeline.handle(
      new Request('http://localhost/x', { method: 'POST', body: bytes }),
      { role: 'web' },
    );
    expect(response.status).toBe(422);
    expect(((await response.json()) as { code: string }).code).toBe('X_BODY_INVALID');
  });
});
