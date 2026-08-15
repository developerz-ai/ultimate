import { describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { type FetchLike, rpc } from './client';
import { RemoteActionError, RpcFailedError } from './errors';
import { BUILD_ID_HEADER } from './http';

const Input = t.object({ postId: t.uuid });
const Output = t.object({ id: t.uuid, published: t.boolean });
const POST_ID = '00000000-0000-4000-8000-0000000000aa';

const publishPost = action({
  input: Input,
  output: Output,
  policy: can('post:publish'),
  handle: () => ({ id: POST_ID, published: true }),
}).named('publishPost');

const actions = { publishPost };

/** One failing round trip: the server answers `problem`, the client hands back what it built. */
async function failWith(answer: {
  readonly body: Readonly<Record<string, unknown>>;
  readonly status: number;
}): Promise<unknown> {
  const fetchStub: FetchLike = async () =>
    Response.json(answer.body, {
      status: answer.status,
      headers: { 'content-type': 'application/problem+json' },
    });
  const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub });
  return api.publishPost({ postId: POST_ID }).catch((error: unknown) => error);
}

describe('typed client', () => {
  test('round trips against a fake fetch and hits the derived path', async () => {
    const seen: { url: string | null; body: string | null; build: string | null } = {
      url: null,
      body: null,
      build: null,
    };
    const fetchStub: FetchLike = async (url, init) => {
      seen.url = url;
      seen.body = String(init.body);
      seen.build = new Headers(init.headers).get(BUILD_ID_HEADER);
      return Response.json({ id: POST_ID, published: true });
    };

    const api = rpc<typeof actions>({
      baseUrl: 'https://app.test/',
      fetch: fetchStub,
      buildId: 'build-1',
    });
    const result = await api.publishPost({ postId: POST_ID });

    expect(seen.url).toBe('https://app.test/api/posts/publish');
    expect(seen.body).toBe(JSON.stringify({ postId: POST_ID }));
    expect(seen.build).toBe('build-1');
    expect(result).toEqual({ id: POST_ID, published: true });
  });

  test('problem+json becomes a typed UltimateError with the server fix line', async () => {
    const fetchStub: FetchLike = async () =>
      Response.json(
        {
          type: 'https://ultimate.dev/errors/X_INPUT_INVALID',
          title: 'input invalid',
          status: 400,
          code: 'X_INPUT_INVALID',
          cause: 'postId is not a uuid',
          fix: 'x actions describe publishPost --json',
        },
        { status: 400, headers: { 'content-type': 'application/problem+json' } },
      );

    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub });
    const failure = await api.publishPost({ postId: 'nope' }).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('X_INPUT_INVALID');
    expect((failure as { fix?: string }).fix).toBe('x actions describe publishPost --json');
  });

  test('a registered code keeps the docs link this build declared for it', async () => {
    const failure = await failWith({
      body: { code: 'X_INPUT_INVALID', cause: 'postId is not a uuid' },
      status: 400,
    });
    expect(failure).toBeInstanceOf(RemoteActionError);
    expect((failure as RemoteActionError).docs).toBe('https://ultimate.dev/errors/X_INPUT_INVALID');
  });

  test("an app's own code is marked remote-origin and never linked to an invented page", async () => {
    const failure = await failWith({
      body: { code: 'X_SIGNUP_CLOSED', cause: 'signups are closed', fix: 'ask for an invite' },
      status: 403,
    });

    // The code rides along verbatim — matching on it is the point of problem+json.
    expect(failure).toBeInstanceOf(RemoteActionError);
    expect((failure as RemoteActionError).code).toBe('X_SIGNUP_CLOSED');
    expect((failure as RemoteActionError).fix).toBe('ask for an invite');
    expect((failure as RemoteActionError).status).toBe(403);
    expect((failure as RemoteActionError).meta).toEqual({
      origin: 'remote',
      action: 'publishPost',
      status: 403,
    });
    // ...and no page documents it, so the link is the index, not `/errors/X_SIGNUP_CLOSED`.
    expect((failure as RemoteActionError).docs).toBe('https://ultimate.dev/errors/');
    expect((failure as RemoteActionError).toJSON().docs).not.toContain('X_SIGNUP_CLOSED');
  });

  test('the docs link the server sent wins, and a non-URL one never becomes an href', async () => {
    const sent = await failWith({
      body: { code: 'X_SIGNUP_CLOSED', cause: 'closed', docs: 'https://app.test/help/signups' },
      status: 403,
    });
    expect((sent as RemoteActionError).docs).toBe('https://app.test/help/signups');

    // RFC-9457's `type` is a documentation URI, so it is the fallback — but `about:blank` is
    // the RFC's own "no type", and a `javascript:` string is not a link at all.
    const typed = await failWith({
      body: { code: 'X_SIGNUP_CLOSED', cause: 'closed', type: 'https://app.test/problems/closed' },
      status: 403,
    });
    expect((typed as RemoteActionError).docs).toBe('https://app.test/problems/closed');

    const blank = await failWith({
      body: {
        code: 'X_SIGNUP_CLOSED',
        cause: 'closed',
        docs: 'javascript:alert(1)',
        type: 'about:blank',
      },
      status: 403,
    });
    expect((blank as RemoteActionError).docs).toBe('https://ultimate.dev/errors/');
  });

  test('an unusable `docs` falls through to a usable `type` instead of burying it', async () => {
    // Preference is not selection: `docs ?? type` picked the preferred slot on presence alone,
    // so one unusable string cost the reader a link the same response had already offered.
    const smuggled = await failWith({
      body: {
        code: 'X_SIGNUP_CLOSED',
        cause: 'closed',
        docs: 'javascript:alert(1)',
        type: 'https://app.test/problems/closed',
      },
      status: 403,
    });
    expect((smuggled as RemoteActionError).docs).toBe('https://app.test/problems/closed');
  });

  test('a body naming no framework code is X_RPC_FAILED, not a synthesized one', async () => {
    for (const body of [
      { code: '' },
      { code: 'error' },
      { code: 'x_lower_case' },
      { message: 'nope' },
    ]) {
      const failure = await failWith({ body, status: 502 });
      expect(failure).toBeInstanceOf(RpcFailedError);
      expect((failure as RpcFailedError).code).toBe('X_RPC_FAILED');
    }
  });

  test('`then` is undefined, so awaiting the client resolves to the client', async () => {
    // A method under `then` makes the client a thenable: `await client` would post an action
    // named "then" and resolve to its answer instead of handing back the client.
    let called = 0;
    const fetchStub: FetchLike = () => {
      called += 1;
      return Promise.resolve(Response.json({ id: POST_ID, published: true }));
    };
    const api = rpc<typeof actions>({ baseUrl: 'https://app.test', fetch: fetchStub });

    expect((api as unknown as Record<string, unknown>)['then']).toBeUndefined();
    expect(await api).toBe(api);
    expect(called).toBe(0);
  });

  test('a server on another build raises X_CONTRACT_DRIFT', async () => {
    const fetchStub: FetchLike = async () =>
      Response.json(
        { id: POST_ID, published: true },
        { headers: { [BUILD_ID_HEADER]: 'build-2' } },
      );

    const api = rpc<typeof actions>({
      baseUrl: 'https://app.test',
      fetch: fetchStub,
      buildId: 'build-1',
    });
    const failure = await api.publishPost({ postId: POST_ID }).catch((error: unknown) => error);
    expect((failure as { code?: string }).code).toBe('X_CONTRACT_DRIFT');
  });
});
