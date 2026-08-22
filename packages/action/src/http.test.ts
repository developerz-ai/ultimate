// The route projection, proven over the real pipeline rather than by calling `route.handler`:
// an action route has ONE authz evaluation, it happens inside `invoke`, and it happens after
// `row` has loaded.

import { describe, expect, test } from 'bun:test';
import type { Actor } from '@ultimat3/core';
import { createContext, isUltimateError, runWithContext, userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig, setRedirect } from '@ultimat3/http';
import type { Actor as PolicyActor } from '@ultimat3/policy';
import { allow, and, can, or } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { AnyAction } from './action';
import { action } from './action';
import { toOpenApiOperation, toRoute } from './http';
import { invoke } from './invoke';

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

// `permissions` — direct grants, bypassing roles — is what `can()` reads through `actorHas`, and
// it is core's field now, so the builder carries it and the actor comes back FROZEN. The spread
// this used to be produced an unfrozen actor, a shape no request ever mints.
const editor = (id: string): PolicyActor => userActor({ id, permissions: ['post:publish'] });

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

    // The `auth` stage answers this one: `meta.auth` is 'required' when no branch of the policy
    // admits an anonymous caller. Authentication, not authorization — hence the count of zero.
    expect(response.status).toBe(401);
    expect(evaluations.count).toBe(0);
  });
});

/**
 * `meta.auth` used to read the ROOT combinator — `policy.kind === 'allow'` — so a policy with a
 * public BRANCH was 401'd by the `auth` stage before `invoke` ever ran, while the MCP tool and the
 * job handle allowed the same caller through the same policy object. One policy, a different
 * answer per surface, which is the thing `enforcedBy: 'handler'` exists to prevent.
 */
describe('an action whose policy has a public branch', () => {
  const openOrEditor = () =>
    action({
      input: Input,
      output: Output,
      policy: or(allow('public'), can<Parsed, Draft>('post:publish')),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');

  test('is reachable by an anonymous caller, because a branch admits one', async () => {
    const response = await publish(serve(openOrEditor(), null));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: POST_ID, published: true });
  });

  test('projects auth: public, so the stage stands down and `invoke` decides', () => {
    expect(toRoute(openOrEditor()).meta.auth).toBe('public');
  });

  test('a policy whose every branch needs a grant still projects auth: required', () => {
    const guarded = action({
      input: Input,
      output: Output,
      policy: and(allow('public'), can<Parsed, Draft>('post:publish')),
      handle: ({ input }) => ({ id: input.postId, published: true }),
    }).named('publishPost');

    expect(toRoute(guarded).meta.auth).toBe('required');
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

  // The row lives in `packages/http/src/error-map.ts` — the framework's one code-to-status table,
  // which this package may not write to — and it is there: `X_IDEMPOTENCY_KEY_INVALID: 400`,
  // pinned by that file's own test. This asserts the two ends agree. A code with no row is
  // `DEFAULT_STATUS`, and `pipeline.ts` reports every `status >= 500` to the error monitor, so a
  // caller's blank header would page whoever is on call — which is why it is pinned from both sides.
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

// Axiom 2, enforced instead of described: the operation an app publishes and the response the
// server sends are two projections of ONE action, so a client written against the document has to
// be right. The expectation is READ OUT OF the published operation rather than written down here
// — a test that hardcoded `400` would pass just as happily if both halves drifted together.
describe('the published operation and the live response are one contract', () => {
  const target = publisher('u1', { count: 0 });

  const badBody = (body: string): Promise<Response> =>
    createServer({
      routes: [toRoute(target)],
      config: oneProcess(),
      hooks: { authenticate: () => editor('u1') },
    }).fetch(
      new Request('http://dev.test/api/posts/publish', {
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: 'http://dev.test' },
        body,
      }),
    );

  // Four shapes of "the body is not what this action declared", because the divergence was not an
  // edge case: every one of them answered 422 X_BODY_INVALID while the document promised 400.
  // Two DIFFERENT failures, which is the half the original divergence hid. The first three
  // parsed and then failed this action's schema; the fourth never became a body at all, and that
  // is raised in `bodyRaw()` before a schema exists to fail — so it keeps `X_BODY_INVALID`, and
  // the operation publishes both.
  const REFUSED: readonly (readonly [string, string, string])[] = [
    ['a field of the wrong type', JSON.stringify({ postId: 'not-a-uuid' }), 'X_INPUT_INVALID'],
    ['a missing required field', JSON.stringify({}), 'X_INPUT_INVALID'],
    ['a JSON null where an object belongs', 'null', 'X_INPUT_INVALID'],
    ['a body that is not JSON at all', '{', 'X_BODY_INVALID'],
  ];

  test('every refusal answers a status the operation actually publishes', async () => {
    const published = Object.keys(toOpenApiOperation(target).responses);

    for (const [label, body] of REFUSED) {
      const response = await badBody(body);
      expect(published, `${label}: ${response.status} is not in the published operation`).toContain(
        String(response.status),
      );
    }
  });

  test('and it is the code the operation names for that status', async () => {
    const responses = toOpenApiOperation(target).responses;

    for (const [label, body, code] of REFUSED) {
      const response = await badBody(body);
      const problem: unknown = await response.json();
      expect((problem as { readonly code: string }).code, label).toBe(code);
      const declared = responses[String(response.status)];
      // The description is `problemResponse(code)`'s own text, so the document names the code.
      expect(JSON.stringify(declared), label).toContain(code);
    }
  });

  // The half a contract test cannot see, and the reason this is `X_INPUT_INVALID` and not a
  // renamed 422: the SAME action invoked without HTTP answers the same code. An action whose
  // input error depends on the surface it arrived through is two actions.
  test('a direct invocation refuses with the same code the route does', async () => {
    const overHttp: unknown = await (await badBody(JSON.stringify({ postId: 'nope' }))).json();
    let direct = 'resolved';
    try {
      // In a context, because `invoke` needs one before it validates anything — the point here is
      // the CODE the same input produces off the wire, not what an unhosted call does.
      await runWithContext(createContext({ actor: editor('u1') }), () =>
        invoke(target, { postId: 'nope' }, { surface: 'http' }),
      );
    } catch (error) {
      direct = isUltimateError(error) ? error.code : String(error);
    }
    expect(direct).toBe((overHttp as { readonly code: string }).code);
    expect(direct).toBe('X_INPUT_INVALID');
  });
});
