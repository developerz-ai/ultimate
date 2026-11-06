// contract — the customer client generated from `examples/dummy`'s published document compiles
// under `strict` with NOTHING but the platform on its path, carries every operation the document
// publishes, and sends what each one declares. The app-side call is the reference app's own
// contract test (`apps/web/app/posts/customer-client.contract.test.ts`).

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp; the compile runs in a fresh directory per run.
import { mkdtemp, rm } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp directory, which only node:os names.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { emitCustomer } from './client-emit-customer';
import { compileOpenApi } from './openapi-compile';

const REPO = join(import.meta.dir, '..', '..', '..');
const document: unknown = await Bun.file(join(REPO, 'examples/dummy/openapi.json')).json();
const compiled = compileOpenApi(document, { source: 'openapi.json' });
const files = emitCustomer(compiled);

const dir = await mkdtemp(join(tmpdir(), 'x-client-customer-'));
afterAll(() => rm(dir, { recursive: true, force: true }));
await Bun.write(join(dir, 'index.ts'), files['index.ts']);
await Bun.write(join(dir, 'types.ts'), files['types.ts']);
await Bun.write(
  join(dir, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      target: 'ES2023',
      module: 'ESNext',
      moduleResolution: 'bundler',
      lib: ['ES2023', 'DOM'],
      types: [],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      noPropertyAccessFromIndexSignature: true,
      verbatimModuleSyntax: true,
      noEmit: true,
    },
    include: ['*.ts'],
  }),
);

describe('contract · the customer client', () => {
  test('imports nothing but its own types file', () => {
    const imports = [...files['index.ts'].matchAll(/from '([^']+)'/g)].map((m) => m[1]);
    expect(imports).toEqual(['./types']);
    expect(files['types.ts']).not.toContain('import ');
  });

  test('compiles under strict with no @ultimat3 package on the path', () => {
    const tsc = Bun.spawnSync([join(REPO, 'node_modules/.bin/tsc'), '-p', dir], {
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    expect(`${tsc.stdout.toString()}${tsc.stderr.toString()}`).toBe('');
    expect(tsc.exitCode).toBe(0);
  });

  test('carries every operation the document publishes', async () => {
    const published = Object.values(
      (document as { paths: Record<string, Record<string, { operationId: string }>> }).paths,
    )
      .flatMap((item) => Object.values(item).map((op) => op.operationId))
      .sort();
    const mod = (await import(join(dir, 'index.ts'))) as {
      createClient(options: unknown): Record<string, unknown>;
    };
    expect(Object.keys(mod.createClient({ baseUrl: 'https://postly.example' })).sort()).toEqual(
      published,
    );
  });

  test('fills the path, sends the body fields and narrows a declared refusal', async () => {
    const mod = (await import(join(dir, 'index.ts'))) as {
      createClient(options: unknown): {
        publishPost(input: unknown): Promise<unknown>;
      };
      refusalOf(error: unknown, operation: string): string | undefined;
    };
    const sent: { url: string; body: unknown }[] = [];
    const client = mod.createClient({
      baseUrl: 'https://postly.example/',
      headers: () => ({ authorization: 'Bearer k' }),
      fetch: async (url: string, init: RequestInit) => {
        sent.push({ url, body: JSON.parse(String(init.body)) });
        return Response.json(
          { type: 'urn:ultimate:error:X_POST_NOT_FOUND', status: 404, code: 'X_POST_NOT_FOUND' },
          { status: 404 },
        );
      },
    });
    const postId = '00000000-0000-4000-8000-000000000001';
    const orgId = '00000000-0000-4000-8000-000000000002';
    const error = await client.publishPost({ postId, orgId }).catch((e: unknown) => e);
    expect(sent).toEqual([
      { url: `https://postly.example/api/posts/${postId}/publish`, body: { orgId } },
    ]);
    expect(mod.refusalOf(error, 'publishPost')).toBe('X_POST_NOT_FOUND');
    expect(mod.refusalOf(error, 'likePost')).toBeUndefined();
  });
});
