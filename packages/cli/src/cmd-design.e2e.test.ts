// `x design research` in a real Chrome against a LOCAL fixture site — never the live web. The fixture
// is reached through `trustedHosts`, the harness-only seam; the same address on the default path is
// refused. A second server stands in for "inside the network": every way the page can reach it — a
// subresource by name, a redirect, a name that resolves inward — must arrive there zero times.
// Skips with no Chrome, and refuses to skip under `E2E_BROWSER_REQUIRED=1`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir().
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { isUltimateError } from '@ultimat3/core';
import { findChrome } from '@ultimat3/scraping/cdp';
import { E2E_BROWSER_OPEN_MS } from '@ultimat3/testing';
import { defineTheme } from '@ultimat3/ui';
import { runDesignResearch } from './cmd-design';

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const RUN_MS = E2E_BROWSER_OPEN_MS * 4 + 60_000;

const PAGE = (inward: string, leak: string) => `<!doctype html><html><head><style>
  html, body { margin: 0; background: #fafaf9; color: #18181b; font-family: Inter, sans-serif; }
  main { padding: 24px; }
  .cta { background: #2563eb; color: #fff; border-radius: 6px; padding: 12px; display: inline-block; }
  .card { border: 1px solid #e4e4e7; border-radius: 6px; padding: 16px; transition: transform 150ms ease-in-out; }
  .card:hover { transform: scale(1.02); }
  .fade { animation: fade 300ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
  @keyframes fade { from { opacity: 0; } to { opacity: 1; } }
</style></head><body><main>
  <h1 class="fade">Reference</h1>
  <p>Body copy on the page, long enough to count as text.</p>
  <a class="cta" href="/a">One</a> <a href="/b">Two</a> <a href="/c">Three</a>
  <div class="card">A card</div>
  <img alt="" src="${leak}"><img alt="" src="${inward}">
</main></body></html>`;

describe.skipIf(chrome === undefined && !required)('x design research, in Chrome', () => {
  const hits: string[] = [];
  let site: ReturnType<typeof Bun.serve> | undefined;
  let inside: ReturnType<typeof Bun.serve> | undefined;
  const out = mkdtempSync(join(tmpdir(), 'x-design-e2e-'));
  const at = (path: string) => `http://127.0.0.1:${String(site?.port)}${path}`;
  const env = () => ({ CHROME_PATH: chrome ?? '' });
  // `inward.test` is a name the sealed resolver answers with a private address.
  const resolve = async (host: string): Promise<readonly string[]> =>
    host === 'inward.test' ? ['10.0.0.9'] : ['93.184.216.34'];

  beforeAll(() => {
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    inside = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        hits.push(new URL(request.url).pathname);
        return new Response('secret');
      },
    });
    const leak = `http://localhost:${String(inside.port)}/leak.png`;
    const inward = `http://inward.test:${String(inside.port)}/inward.png`;
    site = Bun.serve({
      port: 0,
      hostname: '127.0.0.1',
      fetch: (request) => {
        const path = new URL(request.url).pathname;
        if (path === '/redirect') {
          return Response.redirect(`http://localhost:${String(inside?.port)}/secret`, 302);
        }
        if (path === '/favicon.ico') return new Response(null, { status: 404 });
        return new Response(PAGE(inward, leak), { headers: { 'content-type': 'text/html' } });
      },
    });
  });

  afterAll(() => {
    site?.stop(true);
    inside?.stop(true);
    rmSync(out, { recursive: true, force: true });
  });

  test(
    'measures the fixture: palette, radius and motion into a proposal defineTheme accepts; nothing inward is reached',
    async () => {
      const [reference] = await runDesignResearch({
        urls: [at('/')],
        outDir: out,
        env: env(),
        resolve,
        trustedHosts: ['127.0.0.1'],
      });
      if (reference === undefined) return expect.unreachable('no reference was researched');
      const proposal: unknown = await Bun.file(reference.files.tokens).json();
      expect(proposal).toMatchObject({
        colors: { light: { bg: '250 250 249', fg: '24 24 27', accent: '37 99 235' } },
        radius: { sm: '6px' },
        motion: { duration: { base: '300ms', fast: '150ms' } },
      });
      expect(() => defineTheme(proposal as Parameters<typeof defineTheme>[0])).not.toThrow();
      const facts: unknown = await Bun.file(reference.files.reference).json();
      expect(facts).toMatchObject({ refused: { hosts: ['inward.test', 'localhost'] } });
      const map: unknown = await Bun.file(reference.files.motionMap).json();
      expect(JSON.stringify(map)).toContain('"trigger":"hover"');
      expect(hits).toEqual([]);
    },
    RUN_MS,
  );

  test(
    'a redirect to an inward address is X_DESIGN_URL_REFUSED and gets no request through',
    async () => {
      let code = '';
      try {
        await runDesignResearch({
          urls: [at('/redirect')],
          outDir: out,
          env: env(),
          resolve,
          trustedHosts: ['127.0.0.1'],
          viewports: [{ width: 390, height: 844 }],
        });
      } catch (error) {
        code = isUltimateError(error) ? error.code : String(error);
      }
      expect(code).toBe('X_DESIGN_URL_REFUSED');
      expect(hits).toEqual([]);
    },
    RUN_MS,
  );

  test(
    '--follow takes at most n of the page’s same-origin links',
    async () => {
      const references = await runDesignResearch({
        urls: [at('/')],
        outDir: out,
        env: env(),
        resolve,
        trustedHosts: ['127.0.0.1'],
        follow: 1,
        viewports: [{ width: 390, height: 844 }],
      });
      expect(references.map((reference) => reference.url)).toEqual([at('/'), at('/a')]);
    },
    RUN_MS,
  );

  test('the same fixture on the default path is refused: loopback has no flag', async () => {
    let code = '';
    try {
      await runDesignResearch({ urls: [at('/')], outDir: out, env: env(), resolve });
    } catch (error) {
      code = isUltimateError(error) ? error.code : String(error);
    }
    expect(code).toBe('X_DESIGN_URL_REFUSED');
  });
});
