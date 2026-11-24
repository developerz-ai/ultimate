// A form body is text on the wire, as a query string is: `ok=true` is the string "true". The action
// route coerces a form's fields toward the input schema the way a query route coerces its query,
// so a `<form method="post">` reaches `t.boolean` and `t.number.int()` fields. JSON is never coerced:
// its types are the caller's own.

import { describe, expect, test } from 'bun:test';
import type { HttpConfig } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { toRoute } from './http';

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const save = action({
  input: t.object({
    title: t.string,
    ok: t.boolean,
    count: t.number.int(),
    tags: t.array(t.string),
  }),
  output: t.object({ ok: t.boolean, count: t.number.int(), tags: t.array(t.string) }),
  policy: allow(),
  handle: ({ input }) => ({ ok: input.ok, count: input.count, tags: input.tags }),
}).named('saveSetting');

const send = (body: BodyInit, headers: Record<string, string>) =>
  httpServer({ routes: [toRoute(save)], config: oneProcess() }).fetch(
    new Request('http://dev.test/api/settings/save', {
      method: 'POST',
      headers: { origin: 'http://dev.test', ...headers },
      body,
    }),
  );

const URLENCODED = { 'content-type': 'application/x-www-form-urlencoded' };

describe('a form body is coerced toward the action input', () => {
  test('urlencoded: a boolean, an integer and a one-item list', async () => {
    const response = await send('title=a&ok=true&count=3&tags=x', URLENCODED);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, count: 3, tags: ['x'] });
  });

  test('a hidden "false" before its checkbox: the last value wins, as in a query', async () => {
    const response = await send('title=a&ok=false&ok=on&count=0&tags=x&tags=y', URLENCODED);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, count: 0, tags: ['x', 'y'] });
  });

  test('multipart: the same fields', async () => {
    const form = new FormData();
    form.set('title', 'a');
    form.set('ok', 'false');
    form.set('count', '12');
    form.set('tags', 'x');
    const response = await send(form, {});
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: false, count: 12, tags: ['x'] });
  });

  test('a value that is not one stays refused, with the schema naming it', async () => {
    const response = await send('title=a&ok=maybe&count=3&tags=x', URLENCODED);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('X_INPUT_INVALID');
  });

  test('JSON is the caller typing its own values: "true" stays a string, refused', async () => {
    const response = await send(JSON.stringify({ title: 'a', ok: 'true', count: 3, tags: [] }), {
      'content-type': 'application/json',
    });
    expect(response.status).toBe(400);
  });
});
