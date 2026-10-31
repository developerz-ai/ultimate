// A download query over the REAL pipeline: the typed client mints, the URL serves with no session
// at all, the bytes and headers are what a `<video>` and a save dialog need, and every refusal —
// the policy at mint, an expired, forged or re-pointed token at serve — answers its own status.

import { describe, expect, test } from 'bun:test';
import { ctxOf, frozenClock, open, seal, userActor } from '@ultimat3/core';
import type { HttpConfig } from '@ultimat3/http';
import { defineHttpConfig, httpServer } from '@ultimat3/http';
import type { Actor } from '@ultimat3/policy';
import { can } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { FetchLike } from './client';
import { queryClient } from './client';
import type { DownloadFile } from './download';
import { toQueryRoute } from './http';
import type { AnyQuery } from './query';
import { query } from './query';

const RUN = '00000000-0000-4000-8000-000000000001';
const OTHER_RUN = '00000000-0000-4000-8000-000000000002';
const VIDEO = new TextEncoder().encode('0123456789');
const Input = t.object({ runId: t.uuid });

const viewer = (): Actor => userActor({ id: 'u1', orgId: 'o1', permissions: ['recording:read'] });

/** A sealed object store, as an app's `debug` disk holds one: ciphertext at rest, per-key purpose. */
const sealedDisk = new Map<string, string>();
const purpose = (key: string): string => `run-debug:${key}`;
sealedDisk.set(`runs/${RUN}/video`, await seal(VIDEO, { purpose: purpose(`runs/${RUN}/video`) }));

function recording(answer?: (bytes: Uint8Array) => DownloadFile) {
  return query({
    input: Input,
    policy: can<{ runId: string }>('recording:read', ({ input }) => input.runId !== OTHER_RUN),
    download: {
      expiresInMs: 60_000,
      async handle({ input }) {
        const key = `runs/${input.runId}/video`;
        const stored = sealedDisk.get(key) ?? '';
        // The app's own unseal: an AES-GCM envelope opens whole, then is served as plain bytes.
        const bytes = await open(stored, { purpose: purpose(key) });
        return (
          answer?.(bytes) ?? {
            body: bytes,
            contentType: 'video/mp4',
            filename: `run “${input.runId.slice(0, 4)}”.mp4`,
          }
        );
      },
    },
  }).named('runRecording');
}

const oneProcess = (): HttpConfig => defineHttpConfig({ rateLimit: { scope: 'process' } });

/** `actor` is whoever the session says is asking — `null` is a request with no session at all. */
function serve(target: AnyQuery, actor: () => Actor | null) {
  return httpServer({
    routes: [toQueryRoute(target)],
    config: oneProcess(),
    hooks: { authenticate: () => actor() },
  });
}

type Server = ReturnType<typeof serve>;
const get = (server: Server, path: string, headers: Record<string, string> = {}) =>
  server.fetch(new Request(`http://dev.test${path}`, { headers }));
const json = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

/** Mint as the viewer through the typed client, then hand back the path a player would GET. */
async function mintedPath(server: Server, runId = RUN): Promise<string> {
  const fetchLike: FetchLike = (input, init) => server.fetch(new Request(input, init));
  const client = queryClient<{ runRecording: ReturnType<typeof recording> }>({
    baseUrl: 'http://dev.test',
    fetch: fetchLike,
  });
  const { url, expiresAt } = await client.runRecording.url({ runId });
  expect(url).toStartWith(`http://dev.test/_x/query/run-recording?runId=${runId}&_token=`);
  expect(Date.parse(expiresAt)).toBeGreaterThan(Date.now());
  return url.slice('http://dev.test'.length);
}

describe('the mint', () => {
  test('is the read’s own route, public, enforced by the handler, never cached', () => {
    const route = toQueryRoute(recording());
    expect([route.method, route.path]).toEqual(['GET', '/_x/query/run-recording']);
    expect(route.meta).toMatchObject({
      auth: 'public',
      enforcedBy: 'handler',
      policy: 'recording:read',
      primitive: 'query',
      cache: { mode: 'no-store' },
      tags: ['query', 'download'],
    });
  });

  test('runs the policy: 401 with no session, 403 for an input it refuses', async () => {
    let who: Actor | null = null;
    const server = serve(recording(), () => who);
    expect((await get(server, `/_x/query/run-recording?runId=${RUN}`)).status).toBe(401);
    who = viewer();
    const refused = await get(server, `/_x/query/run-recording?runId=${OTHER_RUN}`);
    expect(refused.status).toBe(403);
    const minted = await get(server, `/_x/query/run-recording?runId=${RUN}`);
    expect(minted.status).toBe(200);
    expect(minted.headers.get('cache-control')).toContain('no-store');
    expect(Object.keys(await json(minted)).sort()).toEqual(['expiresAt', 'url']);
  });

  test('a page control or a second token is the caller’s 400', async () => {
    const server = serve(recording(), viewer);
    const paged = await get(server, `/_x/query/run-recording?runId=${RUN}&_first=1`);
    const twice = await get(server, `/_x/query/run-recording?runId=${RUN}&_token=a&_token=b`);
    expect([paged.status, twice.status]).toEqual([400, 400]);
  });
});

describe('the file', () => {
  test('streams the unsealed bytes to a request with NO session, with the download headers', async () => {
    let who: Actor | null = viewer();
    const server = serve(recording(), () => who);
    const path = await mintedPath(server);
    who = null;
    const response = await get(server, path);

    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(VIDEO);
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe('10');
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-disposition')).toBe(
      `attachment; filename="run _0000_.mp4"; filename*=UTF-8''run%20%E2%80%9C0000%E2%80%9D.mp4`,
    );
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-security-policy')).toContain('sandbox');
  });

  test('answers one Range window as 206, and 416 past the end', async () => {
    const server = serve(recording(), viewer);
    const path = await mintedPath(server);

    const window = await get(server, path, { range: 'bytes=2-5' });
    expect(window.status).toBe(206);
    expect(window.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(window.headers.get('content-length')).toBe('4');
    expect(await window.text()).toBe('2345');

    const tail = await get(server, path, { range: 'bytes=-3' });
    expect([tail.status, await tail.text()]).toEqual([206, '789']);

    const beyond = await get(server, path, { range: 'bytes=10-' });
    expect(beyond.status).toBe(416);
    expect(beyond.headers.get('content-range')).toBe('bytes */10');
  });

  test('a stream with a size is range-served; without one it is whole, accept-ranges: none', async () => {
    const streamOf = (bytes: Uint8Array) => new Blob([bytes.slice()]).stream();
    const sized = recording((bytes) => ({
      body: streamOf(bytes),
      size: bytes.byteLength,
      contentType: 'video/mp4',
      filename: 'a.mp4',
    }));
    const server = serve(sized, viewer);
    const window = await get(server, await mintedPath(server), { range: 'bytes=7-8' });
    expect([window.status, await window.text()]).toEqual([206, '78']);

    const unsized = recording((bytes) => ({
      body: streamOf(bytes),
      contentType: 'video/mp4',
      filename: 'a.mp4',
      disposition: 'inline',
    }));
    const plain = serve(unsized, viewer);
    const whole = await get(plain, await mintedPath(plain), { range: 'bytes=7-8' });
    expect([whole.status, await whole.text()]).toEqual([200, '0123456789']);
    expect(whole.headers.get('accept-ranges')).toBe('none');
    expect(whole.headers.get('content-disposition')).toStartWith('inline;');
  });

  test('a handle answering a base64 string is a 500 naming the fix, never served', async () => {
    const wrong = recording(() => ({
      body: 'MDEy' as unknown as Uint8Array,
      contentType: 'x/y',
      filename: 'a',
    }));
    const server = serve(wrong, viewer);
    const response = await get(server, await mintedPath(server));
    expect(response.status).toBe(500);
  });
});

describe('the token', () => {
  test('is opened before the input is parsed: no genuine token, no schema in the answer', async () => {
    const response = await get(
      serve(recording(), () => null),
      '/_x/query/run-recording?runId=not-a-uuid&_token=forged',
    );
    expect(response.status).toBe(403);
    expect((await json(response))['code']).toBe('X_QUERY_DOWNLOAD_TOKEN_INVALID');
  });

  test('past its expiry: 410 X_QUERY_DOWNLOAD_TOKEN_EXPIRED', async () => {
    const target = recording();
    // Minted on a clock an hour behind the server's: 60 s of life, long gone at the request.
    const clock = frozenClock(Date.now() - 3_600_000);
    const { url } = await target.url({ runId: RUN }, { ctx: ctxOf({ actor: viewer(), clock }) });
    const response = await get(
      serve(target, () => null),
      url,
    );
    expect(response.status).toBe(410);
    expect((await json(response))['code']).toBe('X_QUERY_DOWNLOAD_TOKEN_EXPIRED');
  });

  test('re-pointed at other input, forged, or another query’s: 403 TOKEN_INVALID', async () => {
    const target = recording();
    const server = serve(target, () => null);
    const path = await mintedPath(serve(target, viewer));
    const token = new URL(path, 'http://x').searchParams.get('_token') ?? '';
    const other = query({
      input: Input,
      policy: can('recording:read'),
      download: { handle: async () => ({ body: VIDEO, contentType: 'x/y', filename: 'f' }) },
    }).named('runScreenshot');

    const cases = [
      [server, path.replace(RUN, OTHER_RUN)],
      [
        server,
        path.replace(/.(.{7})$/, (_, tail: string) => `${path.at(-8) === 'A' ? 'B' : 'A'}${tail}`),
      ],
      [serve(other, () => null), path.replace('run-recording', 'run-screenshot')],
      [server, `/_x/query/run-recording?runId=${RUN}&_token=${token.slice(0, 30)}`],
    ] as const;
    for (const [on, url] of cases) {
      const response = await get(on, url);
      expect([url.slice(0, 60), response.status]).toEqual([url.slice(0, 60), 403]);
      expect((await json(response))['code']).toBe('X_QUERY_DOWNLOAD_TOKEN_INVALID');
    }
  });
});
