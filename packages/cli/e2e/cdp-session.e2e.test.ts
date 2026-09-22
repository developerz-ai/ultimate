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
});
