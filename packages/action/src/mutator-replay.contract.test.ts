// A mutator's write, replayed. `useMutation` retries and the offline queue drains under ONE
// `Idempotency-Key`, so a POST whose response was lost arrives a second time — and the server half
// must have run once. Driven through the real pipeline: the header is read by `toRoute`.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import { allow } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { toRoute } from './http';
import { resetIdempotency } from './idempotency';
import { mutator } from './mutator';

const POST_ID = '00000000-0000-4000-8000-0000000000aa';
const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

let likes = 0;

const likePost = mutator({
  input: t.object({ postId: t.uuid }),
  output: t.object({ likes: t.number }),
  policy: allow(),
  idempotent: true,
  local() {},
  server() {
    likes += 1;
    return { likes };
  },
  conflict: 'server-wins',
}).named('likePost');

const post = (key: string): Promise<Response> =>
  createServer({ routes: [toRoute(likePost)], config: oneProcess() }).fetch(
    new Request('http://dev.test/api/posts/like', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ postId: POST_ID }),
    }),
  );

describe('a replayed mutator', () => {
  beforeEach(() => {
    likes = 0;
    resetIdempotency();
  });

  test('one key posted twice applies once, and the replay answers the first result', async () => {
    const key = 'likePost:0192f0c4-0000-7000-8000-000000000001';
    const first = await post(key);
    const replay = await post(key);

    expect(first.status).toBe(200);
    expect(replay.status).toBe(200);
    expect(likes).toBe(1);
    expect(await replay.json()).toEqual(await first.json());
  });

  test('a second key is a second write — the dedupe is per key, not per mutator', async () => {
    await post('likePost:0192f0c4-0000-7000-8000-000000000001');
    await post('likePost:0192f0c4-0000-7000-8000-000000000002');
    expect(likes).toBe(2);
  });
});
