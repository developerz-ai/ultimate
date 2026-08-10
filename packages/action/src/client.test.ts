import { describe, expect, test } from 'bun:test';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import { type FetchLike, rpc } from './client';
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
