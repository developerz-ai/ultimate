// An island that meets an HTTP-layer refusal — a 429 from `@ultimat3/http`'s limiter — with NO http
// module in its chunk: the title comes off the problem body, and the retry waits the delay the
// `Retry-After` header named, because core's decoders read both off the wire. Built the way
// `examples/dummy`'s `shared/browser-client.ts` is, run against a fake `fetch`, and read off the
// artifact on the Bun that ships.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no directory-removal API, and the fixture directory is this process's own.
import { rm } from 'node:fs/promises';
// why: Bun ships no path API; the entry is written INSIDE the package so `@ultimat3/*` resolves
// through the workspace exactly as an island's import does.
import { join } from 'node:path';
import { rpc } from './client';

/** Gitignored repo-wide; one directory per process so concurrent runs never delete each other. */
const FIXTURE_DIR = join(import.meta.dir, '..', '.tmp', `rpc-refusal-${process.pid}`);

afterAll(async () => {
  await rm(FIXTURE_DIR, { recursive: true, force: true });
});

/** `@ultimat3/http`'s own title for the code — a literal, because this chunk must not load http. */
const HTTP_TITLE = 'rate limit exhausted for this key';

interface Probe {
  readonly modules: readonly string[];
  readonly refused: { readonly code?: unknown; readonly title?: unknown; readonly retry?: unknown };
  readonly delayMs: unknown;
}

async function island(): Promise<Probe> {
  const entry = join(FIXTURE_DIR, 'island.ts');
  await Bun.write(
    entry,
    [
      "import { rpc } from '@ultimat3/action';",
      "import { retryDecision } from '@ultimat3/core';",
      'const body = JSON.stringify({',
      "  code: 'X_RATE_LIMITED',",
      `  title: ${JSON.stringify(HTTP_TITLE)},`,
      "  cause: 'the bucket is empty',",
      "  fix: 'wait and retry',",
      '});',
      'const fetch = async () =>',
      '  new Response(body, {',
      '    status: 429,',
      "    headers: { 'content-type': 'application/problem+json', 'retry-after': '2' },",
      '  });',
      "const client = rpc({ baseUrl: 'https://app.test', fetch });",
      'export const refused = await client.createPost({}).catch((error) => error);',
      'const policy = { attempts: 3, base: 50, max: 60_000, factor: 2, curve: "exponential" };',
      'export const delayMs = retryDecision(policy, 1, refused, () => 0).delayMs;',
      '',
    ].join('\n'),
  );
  const built = await Bun.build({ entrypoints: [entry], target: 'browser', format: 'esm' });
  const output = built.outputs[0];
  if (!built.success || output === undefined) {
    return expect.unreachable(`the island did not bundle: ${built.logs.map(String).join('; ')}`);
  }
  const code = await output.text();
  const chunk = join(FIXTURE_DIR, 'island.chunk.js');
  await Bun.write(chunk, code);
  const loaded: { readonly refused?: Probe['refused']; readonly delayMs?: unknown } = await import(
    chunk
  );
  const modules = code
    .split('\n')
    .filter((line) => line.startsWith('// ') && line.includes('packages/http/'))
    .map((line) => line.slice(line.indexOf('packages/http/')));
  return { modules, refused: loaded.refused ?? {}, delayMs: loaded.delayMs };
}

describe('an rpc island refused by the HTTP layer, with no http module in its chunk', () => {
  test('titles the 429 from the body and waits the delay Retry-After named', async () => {
    const { modules, refused, delayMs } = await island();
    expect(modules).toEqual([]);
    expect(refused.code).toBe('X_RATE_LIMITED');
    expect(refused.title).toBe(HTTP_TITLE);
    expect(refused.retry).toBe('retry-after');
    expect(delayMs).toBe(2_000);
  }, 60_000);
});

describe('rpc reads the request id off a refusal', () => {
  const refusal = async (body: Record<string, unknown>): Promise<{ meta?: unknown }> => {
    const fetch = async (): Promise<Response> =>
      new Response(JSON.stringify({ code: 'X_STATE_CONFLICT', cause: 'c', fix: 'f', ...body }), {
        status: 409,
        headers: { 'content-type': 'application/problem+json' },
      });
    const client = rpc<Record<string, never>>({ baseUrl: 'https://app.test', fetch }) as Record<
      string,
      unknown
    >;
    const createCase = client['createCase'] as (input: object) => Promise<unknown>;
    return (await createCase({}).catch((error: unknown) => error)) as { meta?: unknown };
  };

  test('the root member lands on meta beside what the client owns', async () => {
    const { meta } = await refusal({ requestId: 'req-123' });
    expect(meta).toEqual({
      origin: 'remote',
      action: 'createCase',
      status: 409,
      requestId: 'req-123',
    });
  });

  test('a body meta.requestId loses to the root member', async () => {
    const { meta } = await refusal({ requestId: 'req-123', meta: { requestId: 'spoof' } });
    expect(meta).toMatchObject({ requestId: 'req-123' });
  });

  test('a body meta.requestId is no stand-in for a missing root member', async () => {
    const { meta } = await refusal({ meta: { requestId: 'spoof' } });
    expect(meta).not.toHaveProperty('requestId');
  });

  test('an oversized or non-string root member is dropped', async () => {
    for (const requestId of ['r'.repeat(128), '', 42, null]) {
      const { meta } = await refusal({ requestId, meta: { requestId: 'spoof' } });
      expect(meta).not.toHaveProperty('requestId');
    }
  });
});
