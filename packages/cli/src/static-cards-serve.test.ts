// `serveExport`, the dumb file server a card capture photographs through: a directory's
// `index.html`, then the bare file, a 404 for anything else — and never a byte from outside the
// export, whether the escape is spelt plainly, percent-encoded or malformed.

import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive and no recursive delete.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { allowHost } from '@ultimat3/testing';
import { serveExport } from './static-cards-serve';

const root = mkdtempSync(join(tmpdir(), 'x-static-cards-serve-'));
const out = join(root, 'export');
await Bun.write(join(out, 'og', 'home', 'index.html'), '<h1>home card</h1>');
await Bun.write(join(out, 'assets', 'site-1a2b.css'), 'h1{}');
// Beside the export, never in it: what a traversal would reach.
await Bun.write(join(root, 'secret.txt'), 'not served');

const served = serveExport(out);
// The sealed test network admits this one loopback origin and nothing else.
allowHost(new URL(served.origin).host);
afterAll(() => {
  served.stop();
  rmSync(root, { recursive: true, force: true });
});

const get = async (path: string): Promise<{ status: number; body: string }> => {
  const response = await fetch(`${served.origin}${path}`);
  return { status: response.status, body: await response.text() };
};

describe('serveExport', () => {
  test('on loopback, a directory answers its index.html and a file answers itself', async () => {
    expect(served.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(await get('/og/home')).toEqual({ status: 200, body: '<h1>home card</h1>' });
    expect(await get('/assets/site-1a2b.css')).toEqual({ status: 200, body: 'h1{}' });
  });

  test('a missing path is 404', async () => {
    expect((await get('/og/nowhere')).status).toBe(404);
  });

  test('an encoded traversal and a malformed escape are 404, never a file outside', async () => {
    // `%2f`, not `%2e%2e/`: the URL parser collapses a dot segment before the request leaves, and
    // an encoded slash is what reaches the server whole and decodes to `og/../../secret.txt`.
    expect(await get('/og/..%2f..%2fsecret.txt')).toEqual({ status: 404, body: '' });
    expect(await get('/og/%E0%A4%A')).toEqual({ status: 404, body: '' });
  });
});
