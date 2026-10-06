// The shot allow list holds on a POPUP, in a real Chrome. Page-level `Fetch` covers the one page
// the driver attached; a `target=_blank` link or a `window.open`, clicked through the real Input
// path MCP `ui.interact` drives, is a new target that interception never saw — and it reached an
// off-list host. Skips with no Chrome, and refuses to skip under `E2E_BROWSER_REQUIRED=1`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { E2E_BROWSER_OPEN_MS, findChrome } from '@ultimat3/testing';
import type { ShotClock, ShotSession } from './browser-launcher-port';
import { cdpShotDriver } from './cdp-shot-driver';

const clock: ShotClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const SHOT_TIMEOUT_MS = 20_000;
/** Long enough for a popup's navigation to have reached the server if anything let it through. */
const POPUP_SETTLE_MS = 1_500;

describe.skipIf(chrome === undefined && !required)('x shot’s allow list, on a popup', () => {
  const hits: string[] = [];
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  // The SAME server, by an address the allow list does not name.
  const offList = (path: string): string => `http://127.0.0.1:${String(server?.port)}${path}`;

  beforeAll(
    async () => {
      server = Bun.serve({
        port: 0,
        fetch: (request) => {
          // Only what arrived by the OFF-list address counts: the page's own favicon is allowed.
          const url = new URL(request.url);
          if (url.hostname === '127.0.0.1') hits.push(url.pathname);
          return new Response(
            `<!doctype html><html><body style="margin:0">
<a id="link" href="${offList('/leak-link')}" target="_blank">open</a>
<button id="open" onclick="window.open('${offList('/leak-open')}')">open</button>
</body></html>`,
            { headers: { 'content-type': 'text/html' } },
          );
        },
      });
      if (chrome === undefined)
        expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
      session = await cdpShotDriver({ executablePath: chrome }).open({
        name: 'x shot',
        rules: { allowHosts: ['localhost'] },
        clock,
        timeoutMs: SHOT_TIMEOUT_MS,
      });
      await session.page.goto(`http://localhost:${String(server.port)}/`);
    },
    E2E_BROWSER_OPEN_MS + 4 * SHOT_TIMEOUT_MS,
  );

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
  }, E2E_BROWSER_OPEN_MS);

  test(
    'a target=_blank link and a window.open never reach an off-list host, and are recorded refused',
    async () => {
      if (session === undefined) expect.unreachable('the session never opened');
      await session.page.click('#link');
      await session.page.click('#open');
      await Bun.sleep(POPUP_SETTLE_MS);
      expect(hits).toEqual([]);
      const refused = session.page.network().filter((entry) => entry.refused === 'host');
      expect(refused.map((entry) => entry.url).sort()).toEqual([
        offList('/leak-link'),
        offList('/leak-open'),
      ]);
    },
    3 * SHOT_TIMEOUT_MS,
  );
});
