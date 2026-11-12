// `native:` over the real pipeline: a browser's form POST is answered 303 with a flash, a refusal
// lands back with its code readable by the next render, and a fetch of the same action is unchanged.

import { describe, expect, test } from 'bun:test';
import { defineError } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { defineHttpConfig, httpServer, unauthenticated } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { ACTION_ANSWER_COOKIE, parseActionAnswer } from './action-answer';
import { toRoute } from './http';
import { answersNatively } from './native-answer';

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const TakenError = defineError({
  code: 'X_TEST_NATIVE_TITLE_TAKEN',
  status: 409,
  title: 'action native-answer fixture: the title is taken',
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});

const WrongPasswordError = defineError({
  code: 'X_TEST_NATIVE_WRONG_PASSWORD',
  status: 401,
  title: 'action native-answer fixture: the password is wrong',
  cause: 'a fixture',
  fix: 'nothing: a fixture',
});

const create = (native?: { refusal?: boolean }) =>
  action({
    input: t.object({ title: t.string.min(3) }),
    output: t.object({ id: t.string }),
    policy: allow(),
    ...(native === undefined
      ? {}
      : {
          native: {
            success: (post: { readonly id: string }) => `/posts/${post.id}`,
            ...(native.refusal === true ? { refusal: () => '/posts/new?again=1' } : {}),
          },
        }),
    handle: ({ input }) => {
      if (input.title === 'taken') throw new TakenError();
      if (input.title === 'wrong') throw new WrongPasswordError();
      return { id: `p-${input.title}` };
    },
  }).named('createPost');

const FORM = {
  accept: 'text/html,application/xhtml+xml',
  'content-type': 'application/x-www-form-urlencoded',
  origin: 'http://dev.test',
  referer: 'http://dev.test/posts/new',
};

const post = (target: AnyAction, body: string, headers: Record<string, string>) =>
  httpServer({ routes: [toRoute(target)], config: oneProcess() }).fetch(
    new Request('http://dev.test/api/posts/create', { method: 'POST', headers, body }),
  );

/** The flash the response set, read the way the next render reads it. */
function flashOf(response: Response) {
  const line = response.headers
    .getSetCookie()
    .find((c) => c.startsWith(`${ACTION_ANSWER_COOKIE}=`));
  if (line === undefined) return null;
  const value = line.slice(ACTION_ANSWER_COOKIE.length + 1).split(';')[0] ?? '';
  return parseActionAnswer(decodeURIComponent(value));
}

describe('native: a form POST', () => {
  test('succeeds with a 303 to success(output) and a success flash', async () => {
    const response = await post(create({}), 'title=hello', FORM);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/posts/p-hello');
    expect(flashOf(response)).toEqual({ action: 'createPost', outcome: 'success' });
  });

  test('a refusal lands on refusal() with its code and the field issues', async () => {
    const response = await post(create({ refusal: true }), 'title=no', FORM);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/posts/new?again=1');
    const flash = flashOf(response);
    expect(flash).toMatchObject({
      action: 'createPost',
      outcome: 'refusal',
      code: 'X_INPUT_INVALID',
    });
    expect(flash?.outcome === 'refusal' ? flash.issues[0] : null).toMatchObject({
      rule: 'string.min',
      params: { min: 3 },
    });
  });

  test('a refusal with no refusal() goes back to the form page, a declared code included', async () => {
    const response = await post(create({}), 'title=taken', FORM);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/posts/new');
    expect(flashOf(response)).toMatchObject({ code: 'X_TEST_NATIVE_TITLE_TAKEN', issues: [] });
  });

  test("a 401 the handler throws is the form's refusal: a sign-in's wrong password", async () => {
    const response = await post(create({}), 'title=wrong', FORM);
    expect(response.status).toBe(303);
    expect(flashOf(response)).toMatchObject({ code: 'X_TEST_NATIVE_WRONG_PASSWORD' });
  });

  test('X_UNAUTHENTICATED is never a refusal: no session keeps the sign-in path', async () => {
    const guarded = action({
      input: t.object({ title: t.string }),
      output: t.object({ id: t.string }),
      policy: allow(),
      native: { success: () => '/done' },
      handle: () => {
        throw unauthenticated('/api/posts/create');
      },
    }).named('createPost');
    const response = await post(guarded, 'title=hello', FORM);
    expect(response.status).toBe(401);
    expect(flashOf(response)).toBeNull();
  });

  test('a Referer on another host is never a place to send the browser', async () => {
    const response = await post(create({}), 'title=no', {
      ...FORM,
      referer: 'https://evil.test/x',
    });
    expect(response.status).not.toBe(303);
    expect(flashOf(response)).toBeNull();
  });
});

describe('native: never a 303 off this origin', () => {
  const landsOn = (to: string) =>
    action({
      input: t.object({ title: t.string.min(3) }),
      output: t.object({ to: t.string }),
      policy: allow(),
      native: { success: (out: { readonly to: string }) => out.to, refusal: () => to },
      handle: ({ input }) => ({ to: input.title }),
    }).named('createPost');

  for (const referer of [
    'http://dev.test//evil.example/x',
    'http://dev.test/\\evil.example',
    'http://dev.test/.//evil.example',
  ]) {
    test(`a same-host Referer whose path reads as a host is not followed: ${referer}`, async () => {
      const response = await post(create({}), 'title=no', { ...FORM, referer });
      expect(response.status).not.toBe(303);
      expect(flashOf(response)).toBeNull();
    });
  }

  for (const to of ['//evil.example/x', '/\\evil.example', '\\\\evil.example', ' //evil.example']) {
    test(`a scheme-less success target that leaves this origin lands on the form: ${to}`, async () => {
      const response = await post(landsOn('/x'), `title=${encodeURIComponent(to)}`, FORM);
      expect(response.status).toBe(303);
      expect(response.headers.get('location')).toBe('/posts/new');
    });

    test(`a scheme-less refusal target that leaves this origin is not followed: ${to}`, async () => {
      const response = await post(landsOn(to), 'title=no', FORM);
      expect(response.status).not.toBe(303);
    });
  }

  test('a same-origin target is its path; an absolute URL the app wrote is kept', async () => {
    const same = await post(
      landsOn('/x'),
      `title=${encodeURIComponent('http://dev.test/a?b=1')}`,
      FORM,
    );
    expect(same.headers.get('location')).toBe('/a?b=1');
    const away = 'https://client.example/callback?code=1';
    const oauth = await post(landsOn('/x'), `title=${encodeURIComponent(away)}`, FORM);
    expect(oauth.headers.get('location')).toBe(away);
  });

  test('a script scheme is never a landing', async () => {
    const response = await post(
      landsOn('/x'),
      `title=${encodeURIComponent('javascript:alert(1)')}`,
      FORM,
    );
    expect(response.headers.get('location')).toBe('/posts/new');
  });
});

describe('native: every other caller is unchanged', () => {
  test('a fetch of JSON gets the output as JSON', async () => {
    const response = await post(create({ refusal: true }), JSON.stringify({ title: 'hello' }), {
      'content-type': 'application/json',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'p-hello' });
    expect(flashOf(response)).toBeNull();
  });

  test('a JSON body is never a form, even from a caller that accepts html', async () => {
    const response = await post(create({ refusal: true }), JSON.stringify({ title: 'hello' }), {
      ...FORM,
      'content-type': 'application/json',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'p-hello' });
  });

  test('a form body from a caller that does not ask for a page gets JSON', async () => {
    const response = await post(create({ refusal: true }), 'title=hello', {
      ...FORM,
      accept: 'application/json',
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: 'p-hello' });
    expect(flashOf(response)).toBeNull();
  });

  test('a fetch refusal is the problem document', async () => {
    const response = await post(create({ refusal: true }), JSON.stringify({ title: 'no' }), {
      'content-type': 'application/json',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('X_INPUT_INVALID');
  });

  test('an action with no native answers a form POST as it always did', async () => {
    const response = await post(create(), 'title=hello', FORM);
    expect(response.status).toBe(200);
    expect(flashOf(response)).toBeNull();
  });
});

describe('answersNatively', () => {
  test('is the declaration, read off the action', () => {
    expect(answersNatively(create({}))).toBe(true);
    expect(answersNatively(create())).toBe(false);
  });
});
