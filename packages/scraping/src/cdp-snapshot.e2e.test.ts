// `snapshotExpression` in a real Chrome: `elementFromPoint` answers null off-screen, so an element
// below the fold read as "covered" and every act on it waited out its timeout. Driven over
// `--dump-dom` — the expression runs in the page and writes its answer into it — because this
// package may not import `@ultimat3/testing`'s launcher (tier 4 → 5, upward). Skips with no Chrome, and
// refuses to skip under `E2E_BROWSER_REQUIRED=1`.
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
// why: Bun exposes no temp-directory or path-join primitive; the profile and page are files.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseSnapshots, snapshotExpression } from './cdp-snapshot';
import type { ElementSnapshot } from './target';

const CANDIDATES = ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];

/**
 * A browser banner: a product this harness can drive, then a dotted version. The product is part of
 * it because `--version` is not a browser's alone.
 */
const BROWSER_BANNER = /(?:chrome|chromium|edge)[^\n]*?\d+\.\d+/i;
/** A candidate gets this long to answer `--version`; a warm Chrome answers in ~40 ms. */
const PROBE_MS = 15_000;

/**
 * Whether this machine can START `candidate` — not merely whether the file exists. Ubuntu 24.04
 * ships `/usr/bin/chromium-browser` as a wrapper around `snap`: present and executable on every
 * install, and it exits 1 having started nothing where no snap cgroup exists (measured 2026-11). By
 * existence alone this file picked it, and all three tests below reported a dump failure where the
 * header promises a SKIP. TOTAL: an unspawnable, failing, hung or non-browser candidate is `false`.
 * A restatement of `@ultimat3/testing`'s `startsChrome` (`cdp-launch-probe.ts`), which this tier
 * may not import; Linux paths only, so the Windows case that one skips never reaches this.
 */
async function startsChrome(candidate: string): Promise<boolean> {
  let child: ReturnType<typeof Bun.spawn>;
  try {
    child = Bun.spawn([candidate, '--version'], {
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'ignore',
      // Bun's own kill at the deadline: a probe the race below stopped waiting on is not left running.
      timeout: PROBE_MS,
    });
  } catch {
    return false;
  }
  const banner = new Response(child.stdout as ReadableStream<Uint8Array>).text().catch(() => '');
  try {
    // Chrome's own `--version` is this child's time, not the test's — the deadline is the only way
    // to tell a hung snap wrapper from a slow one.
    // One deadline over the exit AND the banner: a grandchild holding stdout outlives the exit.
    const answered = child.exited.then(async (code) =>
      code === 0 ? (await banner).trim() : undefined,
    );
    // real-clock: awaits a spawned Chrome process, not a timer this test arms.
    const printed = await Promise.race([answered, Bun.sleep(PROBE_MS).then(() => undefined)]);
    if (printed === undefined) return false;
    // Silence is accepted: Windows' `chrome.exe` prints no console banner even when it starts.
    return printed === '' || BROWSER_BANNER.test(printed);
  } finally {
    child.kill();
  }
}

const declared = process.env['CHROME_PATH'];
const chrome = await (async () => {
  // `CHROME_PATH` is the operator's answer and is taken as given, unprobed: no list describes a
  // wrapper or a non-standard build, and probing it would overrule the one caller who knows.
  if (declared !== undefined && declared !== '') {
    return (await Bun.file(declared).exists()) ? declared : undefined;
  }
  for (const candidate of CANDIDATES) {
    if (!(await Bun.file(candidate).exists())) continue;
    if (await startsChrome(candidate)) return candidate;
  }
  return undefined;
})();
const required = process.env['E2E_BROWSER_REQUIRED'] === '1';
const dir = mkdtempSync(join(tmpdir(), 'ultimate-snapshot-e2e-'));

afterAll(() => rmSync(dir, { recursive: true, force: true }));

/**
 * `@ultimat3/testing`'s `chromeLaunchFlags`, restated because this package may not import it (same
 * tier); each flag's measured reason is written there (`cdp-launch.ts`). The one this file lacked
 * and most likely paid for on `ubuntu-latest`: without `--password-store=basic` a fresh profile
 * asks the OS keyring over D-Bus — measured locally, it requests `org.freedesktop.secrets`
 * activation — and testing measured that wait at 7-25 s on CI.
 */
const FLAGS = [
  '--headless',
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--password-store=basic',
  '--use-mock-keychain',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  '--window-size=800,600',
];

/**
 * A COLD start is its own budget, never a test's: testing's `LAUNCH_TIMEOUT_MS`, restated. The first
 * launch of a CI job measured 5-19 s more than a warm one, and the first test here used to pay it
 * inside its own 20 s.
 */
const COLD_START_MS = 60_000;
/** A warm `--dump-dom` of a two-element page answers in ~1 s; past this it is hung, and says so. */
const RUN_DEADLINE_MS = 15_000;

/** Chrome's dump of `url`, or a failure naming the deadline and Chrome's own last words. */
async function dumpDom(url: string, deadlineMs: number): Promise<string> {
  if (chrome === undefined) expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
  const child = Bun.spawn(
    [chrome, ...FLAGS, `--user-data-dir=${join(dir, 'profile')}`, '--dump-dom', url],
    { stdout: 'pipe', stderr: 'pipe' },
  );
  let killed = false;
  const timer = setTimeout(() => {
    killed = true;
    child.kill('SIGKILL');
  }, deadlineMs);
  const [dom, stderr] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  await child.exited;
  clearTimeout(timer);
  if (killed) {
    expect.unreachable(`Chrome gave no DOM within ${deadlineMs} ms: ${stderr.slice(-600)}`);
  }
  return dom;
}

/** The page's answer to `expression`, run after `body` is parsed, read back out of the dump. */
async function snapshotIn(body: string, expression: string): Promise<readonly ElementSnapshot[]> {
  const page = join(dir, 'page.html');
  await Bun.write(
    page,
    `<!doctype html><html><body style="margin:0">${body}<script>
document.body.setAttribute('data-out', ${expression});
</script></body></html>`,
  );
  const dom = await dumpDom(`file://${page}`, RUN_DEADLINE_MS);
  const match = /data-out="([^"]*)"/.exec(dom);
  if (match?.[1] === undefined) expect.unreachable(`no answer in the dump: ${dom.slice(0, 200)}`);
  const decoded = match[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&');
  return parseSnapshots(decoded);
}

const BELOW_FOLD = '<div style="height:3000px"></div><button id="go">Go</button>';

describe.skipIf(chrome === undefined && !required)('snapshotExpression, in a real Chrome', () => {
  // The binary's first start and the profile's creation, paid once here — so every test's 20 s
  // measures a snapshot, and whichever test happens to run first no longer carries the machine.
  beforeAll(async () => {
    await dumpDom('about:blank', COLD_START_MS);
  }, COLD_START_MS + 5_000);

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
