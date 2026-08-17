// The route projection, proven over the real pipeline rather than by calling `route.handler`:
// an action route has ONE authz evaluation, it happens inside `invoke`, and it happens after
// `row` has loaded.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig, setRedirect } from '@ultimat3/http';
import { allow, can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { toRoute } from './http';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

type Parsed = { readonly postId: string };
type Draft = { readonly authorId: string };

/**
 * One action per test, so the evaluation counter is its own. The predicate fails closed on
 * `null` — "no loader" and "no such row" are one value, and neither is evidence of permission —
 * which is exactly why an evaluation without the row denies the author.
 */
function publisher(authorId: string, evaluations: { count: number }) {
  return action({
    input: Input,
    output: Output,
    policy: can<Parsed, Draft>('post:publish', ({ actor, row }) => {
      evaluations.count += 1;
      return row !== null && row.authorId === actor?.id;
    }),
    row: () => ({ authorId }),
    handle: ({ input }) => ({ id: input.postId, published: true }),
  }).named('publishPost');
}

/**
 * Every server here runs as ONE process, said out loud: `defineHttpConfig` refuses to guess a
 * rate-limit scope (`X_RATE_LIMIT_SCOPE_UNSET`), because the number of replicas is the one thing
 * only the app knows and a wrong guess enforces every bucket N times over.
 */
const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

const editor = (id: string): Actor => ({ ...userActor({ id }), permissions: ['post:publish'] });

function serve(target: ReturnType<typeof publisher>, actor: Actor | null) {
  return createServer({
    routes: [toRoute(target)],
    config: oneProcess(),
    // No `authorize` hook. An action route must not need one: wiring a second opinion is how a
    // host grows a second authz system, and the pipeline used to 403 any route that declared a
    // policy without one.
    hooks: { authenticate: () => actor },
  });
}

const publish = (server: ReturnType<typeof serve>): Promise<Response> =>
  server.fetch(
    new Request('http://dev.test/api/posts/publish', {
      method: 'POST',
      // A credentialed write must show it is same-origin, or the `csrf` stage refuses it before
      // the handler — the pipeline's own rule, and what a browser form actually sends.
      headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
      body: JSON.stringify({ postId: POST_ID }),
    }),
  );

describe('an action route over the pipeline', () => {
  test('declares that its handler holds the one evaluation', () => {
    const evaluations = { count: 0 };
    const route = toRoute(publisher('u1', evaluations));

    // The policy is still named — dropping it would read as "this action is unguarded".
    expect(route.meta.policy).toBe('post:publish');
    expect(route.meta.enforcedBy).toBe('handler');
    expect(evaluations.count).toBe(0);
  });

  test("the row's own author is allowed, and the policy runs exactly once", async () => {
    const evaluations = { count: 0 };
    const response = await publish(serve(publisher('u1', evaluations), editor('u1')));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: POST_ID, published: true });
    // Twice would mean the pipeline decided too, and it decides from `row: null` — a denial for
    // the row's own author, issued by an authz system that never saw the row. That is the bug
    // these tests exist to keep fixed.
    expect(evaluations.count).toBe(1);
  });

  test('a stranger is denied by that same evaluation, with the policy’s own code', async () => {
    const evaluations = { count: 0 };
    const response = await publish(serve(publisher('u1', evaluations), editor('u2')));
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('X_FORBIDDEN');
    expect(evaluations.count).toBe(1);
  });

  test('an anonymous caller is refused before the policy is ever reached', async () => {
    const evaluations = { count: 0 };
    const response = await publish(serve(publisher('u1', evaluations), null));

    // The `auth` stage answers this one: `meta.auth` is 'required' for any non-`allow` policy.
    // Authentication, not authorization — which is why the count stays at zero.
    expect(response.status).toBe(401);
    expect(evaluations.count).toBe(0);
  });
});

/**
 * `req.header()` is `Headers.get()`, which answers `''` for `Idempotency-Key:` and never `null`,
 * so a blank header used to become a live key — one record shared by every caller who sent one.
 * The refusal is raised before the handler, so nothing has been written when it lands.
 */
describe('an idempotent action over the pipeline', () => {
  const counter = (runs: { count: number }) =>
    action({
      input: t.object({ postId: t.uuid }),
      output: t.object({ runs: t.number }),
      policy: allow(),
      idempotent: true,
      handle: () => {
        runs.count += 1;
        return { runs: runs.count };
      },
    }).named('countPost');

  const call = (target: AnyAction, key: string | null) =>
    createServer({ routes: [toRoute(target)], config: oneProcess() }).fetch(
      new Request('http://dev.test/api/posts/count', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(key === null ? {} : { 'idempotency-key': key }),
        },
        body: JSON.stringify({ postId: POST_ID }),
      }),
    );

  test('a blank Idempotency-Key is refused with a code, and nothing runs', async () => {
    const runs = { count: 0 };
    const response = await call(counter(runs), '');
    const body = (await response.json()) as { code?: string };

    expect(body.code).toBe('X_IDEMPOTENCY_KEY_INVALID');
    expect(runs.count).toBe(0);
  });

  // RED until `X_IDEMPOTENCY_KEY_INVALID: 400` is added to `ERROR_STATUS` in
  // `packages/http/src/error-map.ts` — the framework's one code-to-status table, which this
  // package may not write to. A code with no row there is `DEFAULT_STATUS`, and `pipeline.ts`
  // reports every `status >= 500` to the error monitor: a caller's blank header would page
  // whoever is on call, which is the exact failure that table's own comment describes.
  test('and it is a 400 — the row belongs in http ERROR_STATUS, not here', async () => {
    const response = await call(counter({ count: 0 }), '');
    expect(response.status).toBe(400);
  });

  test('no header at all is still the un-keyed path, which runs every time', async () => {
    const runs = { count: 0 };
    const target = counter(runs);
    expect((await call(target, null)).status).toBe(200);
    expect((await call(target, null)).status).toBe(200);
    expect(runs.count).toBe(2);
  });
});

/**
 * A JS-less `<form method="post">` is what `site/` encourages — 0kb JS — and this projection
 * wrapped every return in `json()`, so the reader landed on `{"ok":true,"next":"/feed"}`. A
 * `Location` set through `ctx.headers` did not help: it arrived on a 200, which browsers ignore.
 */
describe('an action answering a form post', () => {
  const signIn = (redirectTo: string | null) =>
    action({
      input: t.object({ email: t.email }),
      output: t.object({ ok: t.boolean }),
      policy: allow(),
      handle: () => {
        if (redirectTo !== null) setRedirect(redirectTo);
        return { ok: true };
      },
    }).named('createSession');

  const post = (target: AnyAction) =>
    createServer({ routes: [toRoute(target)], config: oneProcess() }).fetch(
      new Request('http://dev.test/api/sessions/create', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'reader@example.test' }),
      }),
    );

  test('answers 303 with the Location the handler asked for', async () => {
    const response = await post(signIn('/feed'));

    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toBe('/feed');
    expect(await response.text()).toBe('');
  });

  test('an action that asks for nothing still answers its output as json', async () => {
    const response = await post(signIn(null));

    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    expect(await response.json()).toEqual({ ok: true });
  });

  // The intent is per-request state on a context the next request does not share; taking it is
  // what keeps a second call on the same context from inheriting the first one's destination.
  test('the redirect does not leak into the next request', async () => {
    const target = signIn('/feed');
    const server = createServer({ routes: [toRoute(target)], config: oneProcess() });
    const call = () =>
      server.fetch(
        new Request('http://dev.test/api/sessions/create', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'reader@example.test' }),
        }),
      );

    expect((await call()).status).toBe(303);
    expect((await call()).status).toBe(303);
  });
});
