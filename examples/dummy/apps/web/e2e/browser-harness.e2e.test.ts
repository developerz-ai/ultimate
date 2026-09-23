/**
 * e2e — the framework's multi-tab session (`@ultimat3/cli`'s e2e driver), proved against a page
 * this file serves itself, before the plan-101 acceptance suite leans on it. If the session
 * miscounted sockets or left a worker online, every acceptance test would pass or fail for the wrong
 * reason. Private browsers, because one of them deletes `SharedWorker` for every tab it opens.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { E2eSession } from '@ultimat3/cli';
import { openE2eBrowser } from '@ultimat3/cli';
import type { AcceptanceBrowser } from './fixtures/postly';
import { noBrowser } from './fixtures/postly';

/** One socket per origin through a SharedWorker when there is one, one per tab when there is not. */
const PAGE = `<!doctype html><html><body><h1>harness</h1><script>
  window.connected = false;
  if (typeof SharedWorker === 'function') {
    const worker = new SharedWorker('/worker.js', { name: 'sync' });
    worker.port.onmessage = () => { window.connected = true; };
    worker.port.start();
  } else {
    const socket = new WebSocket('ws://' + location.host + '/_x/sync');
    socket.onopen = () => { window.connected = true; };
  }
</script></body></html>`;

const WORKER = `const socket = new WebSocket('ws://' + location.host + '/_x/sync');
const ports = [];
socket.onopen = () => ports.forEach((port) => port.postMessage('open'));
onconnect = (event) => {
  const port = event.ports[0];
  ports.push(port);
  if (socket.readyState === 1) port.postMessage('open');
};`;

const server = Bun.serve({
  port: 0,
  fetch(request, srv) {
    const path = new URL(request.url).pathname;
    if (path === '/_x/sync' && srv.upgrade(request)) return undefined;
    if (path === '/worker.js') {
      return new Response(WORKER, { headers: { 'content-type': 'text/javascript' } });
    }
    return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8' } });
  },
  websocket: { message() {} },
});
const base = `http://localhost:${String(server.port)}`;
const syncSockets = (session: E2eSession): number =>
  session.sockets().filter((url) => url.includes(`${new URL(base).host}/_x/sync`)).length;

/** A browser of its own, the init script (if any) added before any tab opens. */
async function privateBrowser(initScript?: string): Promise<AcceptanceBrowser> {
  const own = await openE2eBrowser();
  if (initScript !== undefined) await own.session.addInitScript(initScript);
  return { session: own.session, close: () => own.close() };
}

afterAll(() => {
  server.stop(true);
});

describe.skipIf(noBrowser)('the multi-tab harness', () => {
  let shared: AcceptanceBrowser;
  let fallback: AcceptanceBrowser;

  beforeAll(async () => {
    shared = await privateBrowser();
    fallback = await privateBrowser('delete window.SharedWorker;');
  }, 60_000);

  afterAll(() => {
    shared.close();
    fallback.close();
  });

  test('two tabs through a SharedWorker are ONE socket, counted in the worker realm', async () => {
    const one = await shared.session.newTab();
    const two = await shared.session.newTab();
    await one.goto(`${base}/`);
    await two.goto(`${base}/`);
    await one.waitFor('window.connected', 'tab one to connect');
    await two.waitFor('window.connected', 'tab two to connect');
    expect(syncSockets(shared.session)).toBe(1);
  }, 45_000);

  test('an init script runs before the page — no SharedWorker, one socket per tab', async () => {
    const one = await fallback.session.newTab();
    const two = await fallback.session.newTab();
    await one.goto(`${base}/`);
    await two.goto(`${base}/`);
    expect(await one.evaluate('typeof SharedWorker')).toBe('undefined');
    await one.waitFor('window.connected', 'tab one to connect');
    await two.waitFor('window.connected', 'tab two to connect');
    expect(syncSockets(fallback.session)).toBe(2);
  }, 45_000);

  test('offline cuts the page, and back online restores it', async () => {
    const tab = await shared.session.newTab();
    await tab.goto(`${base}/`);
    await shared.session.offline(true);
    const cut = await tab.evaluate("fetch('/ping').then(() => 'reached', () => 'refused')");
    await shared.session.offline(false);
    const back = await tab.evaluate("fetch('/ping').then(() => 'reached', () => 'refused')");
    expect([cut, back]).toEqual(['refused', 'reached']);
    expect(
      shared.session.requests().some((line) => line.startsWith('GET ') && line.endsWith('/ping')),
    ).toBe(true);
  }, 45_000);
});
