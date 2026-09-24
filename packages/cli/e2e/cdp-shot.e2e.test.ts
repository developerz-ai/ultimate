// `x shot`'s raw-CDP driver against a real Chrome: the allow list refusing a request the page
// makes, the console and a thrown exception captured, a click that is a real `pointerdown`, a
// chord the page reads as `metaKey`, the emulated scheme, the accessibility tree and a clipped
// PNG. Skips with no Chrome, and refuses to skip under `E2E_BROWSER_REQUIRED=1`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { findChrome } from '@ultimat3/testing';
import type { ShotClock, ShotSession } from '../src/browser-launcher-port';
import { cdpShotDriver } from '../src/cdp-shot-driver';

const DOCUMENT = `<!doctype html><html><head><title>Shot fixture</title>
<style>body { margin: 0 } #box { width: 120px; height: 50px; }</style></head><body>
<button id="go" aria-label="Launch">Go</button>
<input id="field" />
<div id="box">box</div>
<img src="http://blocked.invalid/pixel.png" alt="" />
<p id="out">idle</p>
<script>
  console.warn('booted', 2);
  document.getElementById('go').addEventListener('pointerdown', () => {
    document.getElementById('out').textContent = 'pressed';
  });
  addEventListener('keydown', (event) => {
    if (event.metaKey && event.key === 'K') document.getElementById('out').textContent = 'palette';
  });
  setTimeout(() => { throw new TypeError('island exploded'); }, 0);
</script></body></html>`;

const clock: ShotClock = {
  now: () => new Date(),
  monotonic: () => performance.now(),
  sleep: (ms) => Bun.sleep(ms),
};

/** A PNG's width and height, read off its IHDR chunk. */
const pngSize = (bytes: Uint8Array): readonly [number, number] => {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return [view.getUint32(16), view.getUint32(20)];
};

const chrome = await findChrome(process.env);
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';

describe.skipIf(chrome === undefined && !required)('x shot’s browser, in a real Chrome', () => {
  let server: ReturnType<typeof Bun.serve> | undefined;
  let session: ShotSession | undefined;
  const base = (): string => `http://localhost:${String(server?.port)}`;

  beforeAll(async () => {
    server = Bun.serve({
      port: 0,
      fetch: () => new Response(DOCUMENT, { headers: { 'content-type': 'text/html' } }),
    });
    if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
    const driver = cdpShotDriver({ executablePath: chrome, viewport: { width: 640, height: 480 } });
    session = await driver.open({
      name: 'x shot',
      rules: { allowHosts: ['localhost'] },
      clock,
      timeoutMs: 20_000,
    });
    await session.page.goto(`${base()}/`);
  }, 60_000);

  afterAll(async () => {
    await session?.close();
    server?.stop(true);
  });

  const page = () => {
    if (session === undefined) expect.unreachable('the session never opened');
    return session.page;
  };

  test('the console, the thrown exception and the refused request are all recorded', async () => {
    await page().waitFor('#out', { state: 'attached' });
    await Bun.sleep(100);
    expect(page().console()).toContainEqual(
      expect.objectContaining({ level: 'warn', text: 'booted 2' }),
    );
    expect(page().pageErrors()).toContainEqual(
      expect.objectContaining({ message: 'island exploded' }),
    );
    expect(page().network()).toContainEqual(
      expect.objectContaining({ url: 'http://blocked.invalid/pixel.png', refused: 'host' }),
    );
    expect(page().network()).toContainEqual(
      expect.objectContaining({ url: `${base()}/`, status: 200, resourceType: 'document' }),
    );
  });

  test('a click is a real pointer press, and a chord arrives as metaKey', async () => {
    await page().click('#go');
    expect(await page().evaluate("document.getElementById('out').textContent")).toBe('pressed');
    await page().press('Meta+K');
    expect(await page().evaluate("document.getElementById('out').textContent")).toBe('palette');
  });

  test('type puts the characters into the focused field', async () => {
    await page().type('#field', 'héllo');
    expect(await page().evaluate("document.getElementById('field').value")).toBe('héllo');
  });

  test('the emulated preference is what the page’s media query answers', async () => {
    await page().colorScheme('dark');
    expect(await page().evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(true);
    await page().colorScheme('no-preference');
    expect(await page().evaluate("matchMedia('(prefers-color-scheme: dark)').matches")).toBe(false);
  });

  test('accessibility answers what the browser computed, not the markup', async () => {
    expect(await page().accessibility('#go')).toEqual([
      expect.objectContaining({ role: 'button', name: 'Launch', ignored: false }),
    ]);
  });

  test('a screenshot is a PNG of the viewport, and a clip is that rectangle', async () => {
    expect(pngSize(await page().screenshot())).toEqual([640, 480]);
    const [box] = await page().query('#box');
    expect(box?.box).toBeDefined();
    const clip = { x: 0, y: box?.box?.y ?? 0, width: 120, height: 50 };
    expect(pngSize(await page().screenshot({ clip }))).toEqual([120, 50]);
  });

  test('a goto off the allow list is refused before it leaves', async () => {
    const error = await page()
      .goto('http://blocked.invalid/')
      .catch((e: unknown) => e);
    expect(error).toBeUltimateError('X_SHOT_HOST_REFUSED');
  });
});
