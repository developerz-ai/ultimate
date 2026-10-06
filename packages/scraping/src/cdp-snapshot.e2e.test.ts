// `snapshotExpression` in a real Chrome: `elementFromPoint` answers null off-screen, so an element
// below the fold read as "covered" and every act on it waited out its timeout. Driven over
// `--dump-dom` — the expression runs in the page and writes its answer into it — because this
// package may not import `@ultimat3/testing`'s launcher (same tier). Skips with no Chrome, and
// refuses to skip under `E2E_BROWSER_REQUIRED=1`.
import { afterAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no temp-directory or path-join primitive; the profile and page are files.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnapshots, snapshotExpression } from './cdp-snapshot';
import type { ElementSnapshot } from './target';

const CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
const declared = process.env['CHROME_PATH'];
const chrome = await (async () => {
  for (const candidate of declared ? [declared] : CANDIDATES) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
})();
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const dir = mkdtempSync(join(tmpdir(), 'ultimate-snapshot-e2e-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The page's answer to `expression`, run after `body` is parsed, read back out of the dump. */
async function snapshotIn(body: string, expression: string): Promise<readonly ElementSnapshot[]> {
  if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
  const page = join(dir, 'page.html');
  await Bun.write(
    page,
    `<!doctype html><html><body style="margin:0">${body}<script>
document.body.setAttribute('data-out', ${expression});
</script></body></html>`,
  );
  const child = Bun.spawn(
    [
      chrome,
      '--headless',
      '--no-sandbox',
      '--disable-gpu',
      `--user-data-dir=${join(dir, 'profile')}`,
      '--window-size=800,600',
      '--dump-dom',
      `file://${page}`,
    ],
    { stdout: 'pipe', stderr: 'ignore' },
  );
  const dom = await new Response(child.stdout).text();
  await child.exited;
  const match = /data-out="([^"]*)"/.exec(dom);
  if (match?.[1] === undefined) expect.unreachable(`no answer in the dump: ${dom.slice(0, 200)}`);
  const decoded = match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  return parseSnapshots(decoded);
}

const BELOW_FOLD = '<div style="height:3000px"></div><button id="go">Go</button>';

describe.skipIf(chrome === undefined && !required)('snapshotExpression, in a real Chrome', () => {
  test('a button at y=3000 on a 600px viewport is the hit target once revealed', async () => {
    const [button] = await snapshotIn(BELOW_FOLD, snapshotExpression('#go', { reveal: true }));
    expect(button?.hitTarget).toBe(true);
    // Measured AFTER the scroll: the box is where a click at its centre must land.
    expect(button?.box?.y ?? Number.POSITIVE_INFINITY).toBeLessThan(600);
  }, 20_000);

  test('a read does not scroll: unrevealed, the same button is off-screen and unhittable', async () => {
    const [button] = await snapshotIn(BELOW_FOLD, snapshotExpression('#go'));
    expect(button?.box?.y).toBe(3000);
    expect(button?.hitTarget).toBe(false);
  }, 20_000);

  test('a cookie banner over an on-screen button still reads as covered', async () => {
    const [button] = await snapshotIn(
      '<button id="go">Go</button><div style="position:fixed;inset:0;background:transparent"></div>',
      snapshotExpression('#go', { reveal: true }),
    );
    expect(button?.hitTarget).toBe(false);
  }, 20_000);
});
