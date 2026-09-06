// The route projection, proven over the real pipeline rather than by calling `route.handler`:
// a read is a GET whose search string IS its input, its policy is evaluated once and inside the
// handler, and the URL it answers on is the one `client()` derives with no server import.

import { describe, expect, test } from 'bun:test';
import { userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { createServer, defineHttpConfig } from '@ultimat3/http';
import type { Actor } from '@ultimat3/policy';
import { allow, and, can, or } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { FetchLike } from './client';
import { toQueryRoute } from './http';
import type { AnyQuery, Query } from './query';
import { query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
  readonly orgId: string;
  readonly rank: number;
}

const ORG = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const Input = t.object({ orgId: t.uuid, first: t.number.optional() });

const posts: readonly Post[] = [
  { id: 'a', orgId: ORG, rank: 1 },
  { id: 'b', orgId: OTHER, rank: 2 },
  { id: 'c', orgId: ORG, rank: 3 },
];

const reader = (id: string): Actor => ({ ...userActor({ id }), permissions: ['feed:read'] });

/**
 * One query per test, so the evaluation counter is its own. `named` stands in for registration:
 * a projection needs the name, nothing more.
 */
function feed(evaluations: { count: number }) {
  return query({
    input: Input,
    policy: can('feed:read', () => {
      evaluations.count += 1;
      return true;
    }),
    cache: { tags: [{ entity: 'posts' }] },
    mcp: { expose: true, description: 'The org feed' },
    sql: ({ orgId, first }) =>
      from<Post>('posts', posts)
        .where({ orgId })
        .orderBy('rank')
        .limit(first ?? 50),
  }).named('orgFeed');
}

/**
 * Every server here runs as ONE process, said out loud: `defineHttpConfig` refuses to guess a
 * rate-limit scope (`X_RATE_LIMIT_SCOPE_UNSET`), because the number of replicas is the one thing
 * only the app knows and a wrong guess enforces every bucket N times over.
 */
const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

function serve(target: AnyQuery, actor: Actor | null) {
  return createServer({
    routes: [toQueryRoute(target)],
    config: oneProcess(),
    // No `authorize` hook, on purpose: a query route must not need one. Wiring a second opinion
    // is how a host grows a second authz system, and the pipeline 403s any route that declares a
    // policy without one unless `enforcedBy: 'handler'` stands the stage down.
    hooks: { authenticate: () => actor },
  });
}

type Server = ReturnType<typeof serve>;

const read = (server: Server, search = `?orgId=${ORG}`): Promise<Response> =>
  server.fetch(new Request(`http://dev.test/_x/query/org-feed${search}`, { method: 'GET' }));

describe('the route a query projects', () => {
  test('is a GET on the path client() derives, and declares who enforces it', () => {
    const evaluations = { count: 0 };
    const route = toQueryRoute(feed(evaluations));

    expect(route.method).toBe('GET');
    expect(route.path).toBe('/_x/query/org-feed');
    expect(route.meta.name).toBe('orgFeed');
    // Still named — dropping it would read as "this read is unguarded" in `x routes`.
    expect(route.meta.policy).toBe('feed:read');
    expect(route.meta.enforcedBy).toBe('handler');
    expect(route.meta.description).toBe('The org feed');
    expect(evaluations.count).toBe(0);
  });

  test('declares no input schema, because the pipeline would validate it against a body', () => {
    // A GET has no body, so `meta.input` would fail every read on an absent one before the
    // handler ran. The schema is applied by `runQuery` instead — which the coercion test proves.
    expect(toQueryRoute(feed({ count: 0 })).meta.input).toBeUndefined();
  });

  test('is never cached by a shared cache, and carries the tags a purge names', () => {
    const meta = toQueryRoute(feed({ count: 0 })).meta;

    // The URL names no actor while the answer is scoped to one, so `public` would hand one
    // reader's rows to the next caller of that URL.
    expect(meta.cache?.mode).toBe('no-store');
    expect(meta.cache?.tags).toEqual(['posts']);
    expect(meta.tags).toEqual(['query']);
  });

  test('is public only when the policy admits an anonymous caller', () => {
    const guarded = toQueryRoute(feed({ count: 0 }));
    const open = toQueryRoute(
      query({ input: Input, policy: allow(), sql: () => from<Post>('posts', posts) }).named(
        'publicFeed',
      ),
    );

    expect(guarded.meta.auth).toBe('required');
    expect(open.meta.auth).toBe('public');
  });

  /**
   * `meta.auth` used to read the ROOT combinator — `policy.kind === 'allow'` — so a read with a
   * public BRANCH was 401'd by the `auth` stage before `runQuery` ran, while the MCP tool and a
   * direct server read allowed the same caller through the same policy object.
   */
  test('a public branch under `or` projects auth: public, so the stage stands down', () => {
    const open = toQueryRoute(
      query({
        input: Input,
        policy: or(allow('public'), can('feed:read')),
        sql: () => from<Post>('posts', posts),
      }).named('publicFeed'),
    );

    expect(open.meta.auth).toBe('public');
  });

  test('a read whose every branch needs a grant still projects auth: required', () => {
    const guarded = toQueryRoute(
      query({
        input: Input,
        policy: and(allow('public'), can('feed:read')),
        sql: () => from<Post>('posts', posts),
      }).named('publicFeed'),
    );

    expect(guarded.meta.auth).toBe('required');
  });
});

describe('a query read over the pipeline', () => {
  test('answers the rows as json, with the policy evaluated exactly once', async () => {
    const evaluations = { count: 0 };
    const response = await read(serve(feed(evaluations), reader('u1')));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([
      { id: 'a', orgId: ORG, rank: 1 },
      { id: 'c', orgId: ORG, rank: 3 },
    ]);
    // Twice would mean the pipeline's authz stage decided too — a second authz system, deciding
    // the same policy from the raw search string this one parsed.
    expect(evaluations.count).toBe(1);
  });

  test('decodes the search string against the query’s own schema', async () => {
    const evaluations = { count: 0 };
    // `first` arrives as the characters "1". Without the boundary's coercion the read fails
    // validation on its own limit, which is the whole reason a GET projection decodes first.
    const response = await read(serve(feed(evaluations), reader('u1')), `?orgId=${ORG}&first=1`);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual([{ id: 'a', orgId: ORG, rank: 1 }]);
  });

  test('an input the schema refuses is the query’s own error, not the body stage’s', async () => {
    const response = await read(serve(feed({ count: 0 }), reader('u1')), '?orgId=not-a-uuid');
    const body = (await response.json()) as { code?: string; fix?: string };

    expect(response.status).toBe(400);
    // `X_BODY_INVALID` here would mean a second parser ran: the same read answers
    // `X_INPUT_INVALID` on every other surface, with the line that prints the schema.
    expect(body.code).toBe('X_INPUT_INVALID');
    expect(body.fix).toContain('x queries describe orgFeed');
  });

  test('a caller without the permission is denied by that same evaluation', async () => {
    const evaluations = { count: 0 };
    const guarded = query({
      input: Input,
      policy: can('feed:read', () => {
        evaluations.count += 1;
        return false;
      }),
      sql: ({ orgId }) => from<Post>('posts', posts).where({ orgId }),
    }).named('orgFeed');
    const response = await read(serve(guarded, reader('u1')));
    const body = (await response.json()) as { code?: string };

    expect(response.status).toBe(403);
    expect(body.code).toBe('X_FORBIDDEN');
    expect(evaluations.count).toBe(1);
  });

  test('an anonymous caller is refused before the policy is ever reached', async () => {
    const evaluations = { count: 0 };
    const response = await read(serve(feed(evaluations), null));

    // The `auth` stage answers this one, from `meta.auth`. Authentication, not authorization —
    // which is why the count stays at zero.
    expect(response.status).toBe(401);
    expect(evaluations.count).toBe(0);
  });

  test('a write to a read’s path is refused by method, not answered', async () => {
    const server = serve(feed({ count: 0 }), reader('u1'));
    const response = await server.fetch(
      new Request(`http://dev.test/_x/query/org-feed?orgId=${ORG}`, { method: 'POST' }),
    );

    expect(response.status).toBe(405);
  });

  test('a failure that is not a framework error reaches the server’s error boundary', async () => {
    const broken = query({
      input: Input,
      policy: allow(),
      sql: () => {
        throw new TypeError('sql is not a function');
      },
    }).named('brokenFeed');
    const server = createServer({ routes: [toQueryRoute(broken)], config: oneProcess() });
    const response = await server.fetch(
      new Request(`http://dev.test/_x/query/broken-feed?orgId=${ORG}`),
    );
    const body = (await response.json()) as { code?: string };

    // Rethrown rather than dressed as a read failure: a bug belongs to the boundary that reports
    // it, and `problem()` would have given it a 4xx and a fix line nobody can run.
    expect(response.status).toBe(500);
    expect(body.code).toBe('X_INTERNAL');
  });

  test('an unregistered query cannot be mounted at all', () => {
    const anonymous = query({ input: Input, policy: allow(), sql: () => from('posts', posts) });

    expect(() => toQueryRoute(anonymous)).toThrow('X_QUERY_UNREGISTERED');
  });
});

/**
 * The whole promise in one test: `liveFeed.client({ baseUrl })` derives its URL from the export
 * name with no server import, and the route the same name projects is what answers it. This is
 * what shipped broken — a typed call site that compiled everywhere and 404'd everywhere.
 */
describe('the typed client against the route', () => {
  test('reads its own rows end to end', async () => {
    const target = feed({ count: 0 }) as Query<typeof Input, Post>;
    const server = serve(target, reader('u1'));
    const fetchLike: FetchLike = (input, init) => server.fetch(new Request(input, init));

    const rows = await target.client({ baseUrl: 'http://dev.test', fetch: fetchLike })({
      orgId: ORG,
    });

    expect(rows).toEqual([
      { id: 'a', orgId: ORG, rank: 1 },
      { id: 'c', orgId: ORG, rank: 3 },
    ]);
  });

  test('a denial arrives as the server’s own problem document', async () => {
    const target = feed({ count: 0 }) as Query<typeof Input, Post>;
    const server = serve(target, null);
    const fetchLike: FetchLike = (input, init) => server.fetch(new Request(input, init));
    const call = target.client({ baseUrl: 'http://dev.test', fetch: fetchLike });

    // Not `X_RPC_FAILED`: the server already said what broke, and the client re-throws it verbatim.
    expect(call({ orgId: ORG })).rejects.toThrow('X_UNAUTHENTICATED');
  });
});

/**
 * `?_first=` and `?_after=` — the page controls the route reads OFF the search string before the
 * schema sees it, answering `query.page()`'s own envelope. Without one the answer is the bare
 * array it has always been: every client written before the controls existed keeps reading rows.
 * Before this the page marker had nowhere to ride but on a row (`olderCursor`, ai-maxxing's
 * `sessionMessages`), which is a cursor on the wrong side of the envelope.
 */
describe('a paged read over the route', () => {
  interface PageBody {
    readonly rows: readonly Post[];
    readonly endCursor: string | null;
    readonly hasNextPage: boolean;
  }

  test('with no page control the answer is the bare array it always was', async () => {
    const response = await read(serve(feed({ count: 0 }), reader('u1')));
    expect(Array.isArray(await response.json())).toBe(true);
  });

  test('`_first` answers the Page envelope, and `_after` continues it to a terminal page', async () => {
    const server = serve(feed({ count: 0 }), reader('u1'));
    const one = await read(server, `?orgId=${ORG}&_first=1`);
    expect(one.status).toBe(200);
    const first = (await one.json()) as PageBody;
    expect(first.rows).toEqual([{ id: 'a', orgId: ORG, rank: 1 }]);
    expect(first.hasNextPage).toBe(true);
    expect(typeof first.endCursor).toBe('string');

    const two = await read(server, `?orgId=${ORG}&_first=1&_after=${first.endCursor}`);
    const second = (await two.json()) as PageBody;
    expect(second.rows).toEqual([{ id: 'c', orgId: ORG, rank: 3 }]);
    expect(second.hasNextPage).toBe(false);
  });

  test('the wire cursor is the very string a direct `.page()` call signs', async () => {
    const target = feed({ count: 0 });
    const direct = await target.page({ orgId: ORG }, { first: 1, actor: reader('u1') });
    const response = await read(serve(target, reader('u1')), `?orgId=${ORG}&_first=1`);
    expect(((await response.json()) as PageBody).endCursor).toBe(direct.endCursor);
  });

  test('a page control never reaches the schema — an input named `first` still coerces', async () => {
    // `Input` declares `first` (the read's own limit) beside the route's `_first`: two names, two
    // jobs, and the reserved one is what keeps them apart.
    // (`seek()` sets the window, so the read's `limit(first)` is not what bounds the page —
    // `paginate` has always worked that way; what is pinned is that `first=1` COERCED, as a 200.)
    const response = await read(
      serve(feed({ count: 0 }), reader('u1')),
      `?orgId=${ORG}&first=1&_first=1`,
    );
    expect(response.status).toBe(200);
    const page = (await response.json()) as PageBody;
    expect(page.rows).toHaveLength(1);
    expect(page.hasNextPage).toBe(true);
  });

  test('a cursor that is not this read’s is X_CURSOR_INVALID, a 400', async () => {
    const response = await read(
      serve(feed({ count: 0 }), reader('u1')),
      `?orgId=${ORG}&_first=1&_after=not-a-cursor`,
    );
    const body = (await response.json()) as { code?: string };
    expect(response.status).toBe(400);
    expect(body.code).toBe('X_CURSOR_INVALID');
  });

  test('a page size outside the bound is the read’s own X_INPUT_INVALID, never a 500', async () => {
    const server = serve(feed({ count: 0 }), reader('u1'));
    for (const size of ['0', '10001', '1.5', '1e3', 'many', '']) {
      const response = await read(server, `?orgId=${ORG}&_first=${size}`);
      const body = (await response.json()) as { code?: string; cause?: string };
      expect(response.status).toBe(400);
      expect(body.code).toBe('X_INPUT_INVALID');
      expect(body.cause).toContain('_first');
    }
  });

  test('`_after` alone, or a control sent twice, is refused at the wire', async () => {
    const server = serve(feed({ count: 0 }), reader('u1'));
    for (const search of [`?orgId=${ORG}&_after=abc`, `?orgId=${ORG}&_first=1&_first=2`]) {
      const response = await read(server, search);
      expect(response.status).toBe(400);
      expect(((await response.json()) as { code?: string }).code).toBe('X_INPUT_INVALID');
    }
  });

  test('the typed client’s .page() reads the envelope end to end', async () => {
    const target = feed({ count: 0 }) as Query<typeof Input, Post>;
    const server = serve(target, reader('u1'));
    const fetchLike: FetchLike = (input, init) => server.fetch(new Request(input, init));
    const client = target.client({ baseUrl: 'http://dev.test', fetch: fetchLike });

    const first = await client.page({ orgId: ORG }, { first: 1 });
    expect(first.rows).toEqual([{ id: 'a', orgId: ORG, rank: 1 }]);
    expect(first.hasNextPage).toBe(true);
    const second = await client.page({ orgId: ORG }, { first: 1, after: first.endCursor ?? '' });
    expect(second.rows).toEqual([{ id: 'c', orgId: ORG, rank: 3 }]);
    expect(second.hasNextPage).toBe(false);
  });
});
