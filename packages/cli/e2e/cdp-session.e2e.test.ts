// The BROWSER half of the e2e driver against a real Chrome: two tabs in one profile sharing one
// SharedWorker, a script that runs before the page's own, every WebSocket counted in every realm,
// the network cut for the worker too, and the page's IndexedDB databases listed. Skips with no
// Chrome, and refuses to skip under `E2E_BROWSER_REQUIRED=1`, like `cdp-browser.e2e.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eBrowser } from '../src/cdp-browser';
import { openE2eBrowser, openE2eBrowserIfAvailable } from '../src/cdp-browser';
import { findChrome } from '../src/cdp-launch';

/** The worker every tab connects to: one socket, opened at start-up, for all of them. */
const WORKER = `
const socket = new WebSocket('ws://' + location.host + '/socket');
const ports = [];
socket.onopen = () => { for (const port of ports) port.postMessage('open'); };
onconnect = (event) => {
  const port = event.ports[0];
  ports.push(port);
  port.postMessage(socket.readyState === 1 ? 'open' : 'waiting');
  port.onmessage = () => fetch('/ping').then(() => port.postMessage('online'), () => port.postMessage('offline'));
};`;

const DOCUMENT = `<!doctype html><html><head><title>Session fixture</title></head><body>
<p id="state">booting</p>
<script>
  window.sawInit = window.__init === true;
  const worker = new SharedWorker('/worker.js');
  worker.port.onmessage = (event) => { document.getElementById('state').textContent = event.data; };
  worker.port.start();
  window.ping = () => worker.port.postMessage('ping');
  indexedDB.open('fixture-db');
</script></body></html>`;

/**
 * A worker that answers `/first-script` itself, so the page reloads with the network cut — the
 * shape of an offline PWA reload. The document records `navigator.onLine` at its FIRST script and
 * sends COOP, which is what the dummy app sends and what puts a navigation in a fresh process.
 */
const OFFLINE_WORKER = `
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  if (new URL(event.request.url).pathname !== '/first-script') return;
  event.respondWith(new Response('<!doctype html><script>window.firstOnLine = navigator.onLine;</script>', {
    headers: { 'content-type': 'text/html', 'cross-origin-opener-policy': 'same-origin' },
  }));
});`;

let sockets = 0;
const server = Bun.serve({
  port: 0,
  fetch(request, srv): Response | undefined {
    const path = new URL(request.url).pathname;
    if (path === '/socket') {
      sockets += 1;
      return srv.upgrade(request) ? undefined : new Response('no upgrade', { status: 400 });
    }
    if (path === '/worker.js') {
      return new Response(WORKER, { headers: { 'content-type': 'text/javascript' } });
    }
    if (path === '/ping') return new Response('pong');
    if (path === '/offline-worker.js') {
      return new Response(OFFLINE_WORKER, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(DOCUMENT, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
  websocket: { message: () => undefined },
});
const base = `http://localhost:${String(server.port)}/`;

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
console.log(chrome === undefined ? 'cdp-session: no browser found' : `cdp-session: ${chrome}`);

describe.skipIf(chrome === undefined && !required)('the e2e session, in a real browser', () => {
  let browser: E2eBrowser | undefined;

  beforeAll(async () => {
    browser = required ? await openE2eBrowser() : await openE2eBrowserIfAvailable();
  }, 60_000);

  afterAll(() => {
    browser?.close();
    server.stop(true);
  });

  const opened = (): E2eBrowser => browser ?? expect.unreachable('the browser did not open');

  test('two tabs share one SharedWorker, and the one socket it opens is counted once', async () => {
    const { session, page } = opened();
    await session.addInitScript('window.__init = true;');
    // The first tab was attached before the init script: a new tab is what proves "later tabs too".
    const first = await session.newTab();
    await first.goto(base);
    const second = await session.newTab();
    await second.goto(base);

    await first.waitFor(`document.getElementById('state').textContent === 'open'`, 'the socket');
    await second.waitFor(`document.getElementById('state').textContent === 'open'`, 'the socket');
    expect(await second.evaluate('window.sawInit')).toBe(true);
    // Counted in the WORKER's realm, off the browser's own log — and matched by the server's count.
    expect(session.sockets().filter((url) => url.endsWith('/socket'))).toHaveLength(1);
    expect(sockets).toBe(1);
    expect(page.url()).toBe('about:blank');

    // Offline reaches the worker: its fetch fails while the tab's own page is untouched.
    await session.offline(true);
    await first.evaluate('window.ping()');
    await first.waitFor(`document.getElementById('state').textContent === 'offline'`, 'offline');
    await session.offline(false);
    await first.evaluate('window.ping()');
    await first.waitFor(`document.getElementById('state').textContent === 'online'`, 'online');

    expect(await first.indexedDbNames()).toContain('fixture-db');
    expect(
      session.requests().some((line) => line.startsWith('GET ') && line.endsWith('/ping')),
    ).toBe(true);
    await second.close();
  }, 60_000);

  test('a reload under offline reads navigator.onLine false at the page’s FIRST script', async () => {
    // The page boot replays its outbox when it believes it is online, and it asks at its first
    // script: a document that read `true` there for ~100 ms fired a real POST under an offline
    // switch the test had already thrown (`offline-like.e2e.test.ts`, two attempts where one was
    // asserted). The condition has to hold from the new document's first byte, not arrive later.
    const { session } = opened();
    const tab = await session.newTab();
    try {
      await tab.goto(base);
      await tab.evaluate(
        "navigator.serviceWorker.register('/offline-worker.js').then(() => navigator.serviceWorker.ready).then(() => true)",
      );
      await tab.waitFor('navigator.serviceWorker.controller !== null', 'the worker in control');
      await tab.goto(`${base}first-script`);
      expect(await tab.evaluate('window.firstOnLine')).toBe(true);

      await session.offline(true);
      for (let i = 0; i < 5; i += 1) {
        await tab.reload();
        expect(await tab.evaluate('window.firstOnLine')).toBe(false);
      }

      // Back online: the document that lived through the cut reads the truth without a reload,
      // and the next document is not told it is offline by a script nobody took back.
      await tab.evaluate(
        "window.onlineEvents = 0; addEventListener('online', () => { window.onlineEvents += 1; }); 1",
      );
      await session.offline(false);
      await tab.waitFor('navigator.onLine === true', 'the open document to read online again');
      // Exactly once: the `online` event is what a page reconnects on, and two is two replays.
      await Bun.sleep(300);
      expect(await tab.evaluate('window.onlineEvents')).toBe(1);
      await tab.reload();
      expect(await tab.evaluate('window.firstOnLine')).toBe(true);
    } finally {
      await session.offline(false);
      await tab.close();
    }
  }, 60_000);
});
