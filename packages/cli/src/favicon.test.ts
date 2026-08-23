// A scaffolded app 404'd on `/favicon.ico` on every page load — the only console error on an
// otherwise clean load. These drive the route both served surfaces mount, not the function behind
// it: what an app inherits is the RESPONSE, and a default nothing answers with is not a mechanism.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun has no temp-directory, no mkdtemp and no recursive remove, and each case needs its own
// root or a leftover favicon decides the next one's answer. `join` for the app-relative source.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { probeImage } from '@ultimat3/core';
import type { Route } from '@ultimat3/http';
import { createRequestContext, defineHttpConfig, UltimateRequest } from '@ultimat3/http';
import { FAVICON_PATH, FAVICON_SOURCE, faviconRoute } from './favicon';

let root = '';

const call = async (route: Route): Promise<Response> => {
  const url = new URL(`http://dev.test${FAVICON_PATH}`);
  const config = defineHttpConfig({ rateLimit: { scope: 'process' } });
  const ctx = createRequestContext({ url, method: 'GET', role: 'web', config });
  return route.handler(new UltimateRequest(new Request(url), ctx), ctx);
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'x-favicon-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('unit · favicon', () => {
  // The whole issue: `x new` writes no favicon, so the app that declares nothing is the app every
  // author starts with, and it is the one that has to answer 200.
  test('an app that declares none still answers with a real image', async () => {
    const response = await call(faviconRoute(root));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    // Decoded, not merely counted: a placeholder no decoder accepts is a 200 that renders the same
    // broken icon the 404 did.
    expect(probeImage(new Uint8Array(await response.arrayBuffer()))).toMatchObject({
      format: 'png',
      width: 32,
      height: 32,
    });
  });

  test("the app's own file wins, byte for byte", async () => {
    const own = new Uint8Array([0, 0, 1, 0, 9, 9]);
    await Bun.write(join(root, FAVICON_SOURCE), own);

    const response = await call(faviconRoute(root));
    expect(response.headers.get('content-type')).toBe('image/x-icon');
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(own);
  });

  // `x dev` is a running process an author drops a favicon into. A route that decided at boot
  // would keep serving the placeholder until the server was restarted.
  test('the file is read per request, so dropping one in takes effect without a restart', async () => {
    const route = faviconRoute(root);
    expect((await call(route)).headers.get('content-type')).toBe('image/png');

    await Bun.write(join(root, FAVICON_SOURCE), new Uint8Array([0, 0, 1, 0]));
    expect((await call(route)).headers.get('content-type')).toBe('image/x-icon');
  });

  test('it is public and cacheable — a browser asks for it before anyone signs in', async () => {
    const route = faviconRoute(root);
    expect(route.meta.auth).toBe('public');
    expect(route.meta.policy).toBeUndefined();
    const response = await call(route);
    expect(response.headers.get('cache-control')).toContain('public');
    // Never `immutable`: the app's file can change, and a year-long cache would outlive the app.
    expect(response.headers.get('cache-control')).not.toContain('immutable');
  });
});
