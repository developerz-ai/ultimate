// A form body's fields are text; `body(schema)` and `bodyCoerced(schema)` coerce them toward the
// schema as a query route coerces a query string, and leave a JSON body's types the caller's own.

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { defineHttpConfig } from './config';
import { requestContext } from './context';
import { HttpError } from './errors';
import { UltimateRequest } from './request';

const post = (body: BodyInit, headers: Record<string, string> = {}) => {
  const url = new URL('https://example.com/x');
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = requestContext({ url, method: 'POST', role: 'web', config });
  return new UltimateRequest(new Request(url, { method: 'POST', headers, body }), ctx);
};

const URLENCODED = { 'content-type': 'application/x-www-form-urlencoded' };
const schema = t.object({ ok: t.boolean, count: t.number.int(), tags: t.array(t.string) });

describe('a form body is coerced toward the schema', () => {
  test('body(schema): urlencoded text becomes the declared types', async () => {
    const req = post('ok=on&count=7&tags=a', URLENCODED);
    expect(await req.body(schema)).toEqual({ ok: true, count: 7, tags: ['a'] });
  });

  test('body(schema): multipart text, and a file passes through as sent', async () => {
    const form = new FormData();
    form.set('ok', 'false');
    form.set('count', '2');
    form.set('tags', 'a');
    form.set('file', new File(['x'], 'x.txt'));
    const coerced = (await post(form).bodyCoerced(schema)) as Record<string, unknown>;
    expect([coerced['ok'], coerced['count'], coerced['tags']]).toEqual([false, 2, ['a']]);
    expect(coerced['file']).toBeInstanceOf(File);
  });

  test('a JSON body is never coerced', async () => {
    const req = post(JSON.stringify({ ok: 'true', count: '7', tags: [] }), {
      'content-type': 'application/json',
    });
    expect(await req.bodyCoerced(schema)).toEqual({ ok: 'true', count: '7', tags: [] });
    const error = await req.body(schema).then(
      () => undefined,
      (refused: unknown) => refused,
    );
    expect(error instanceof HttpError ? error.code : error).toBe('X_BODY_INVALID');
  });

  test('a field named __proto__ stays an own key, never the prototype', async () => {
    const coerced = (await post('__proto__=x&ok=on', URLENCODED).bodyCoerced(schema)) as object;
    expect(Object.getPrototypeOf(coerced)).toBeNull();
    expect(Object.getOwnPropertyDescriptor(coerced, '__proto__')?.value).toBe('x');
    expect(Object.getOwnPropertyDescriptor(coerced, 'ok')?.value).toBe(true);
  });
});
