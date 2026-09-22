// Which browser a run gets, and what the launcher does when there is none. The launch itself is
// proved by `e2e/cdp-browser.e2e.test.ts` against a real Chrome; what is testable without one is
// the candidate order and the refusal.

import { describe, expect, test } from 'bun:test';
// why: a throwaway executable script is the fake browser; Bun has no mkdtemp, chmod or recursive rm of its own.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the script and marker paths.
import { join } from 'node:path';
import {
  CHROME_CANDIDATES,
  CHROME_PATH_ENV,
  chromeLaunchFlags,
  findChrome,
  launchChrome,
  launchFoundChrome,
} from './cdp-launch';

const NOWHERE = '/nonexistent/definitely-not-a-browser';

describe('findChrome', () => {
  test('CHROME_PATH wins outright, and nothing else is tried', async () => {
    // `bun` is a file that exists and is not a browser — this asks WHICH path is answered, which
    // is the whole question, and never runs it.
    const bun = process.execPath;

    expect(await findChrome({ [CHROME_PATH_ENV]: bun })).toBe(bun);
  });

  test('an empty CHROME_PATH falls back to the candidate list rather than answering it', async () => {
    // The empty string is what an unset variable becomes in a shell that exported it anyway, and
    // `Bun.file('').exists()` is false — so a rule spelled `!== undefined` would answer undefined
    // on a machine that really does have a browser.
    const found = await findChrome({ [CHROME_PATH_ENV]: '' });

    if (found !== undefined) expect(CHROME_CANDIDATES).toContain(found);
  });

  test('a CHROME_PATH pointing at nothing answers undefined, and does not silently search on', async () => {
    expect(await findChrome({ [CHROME_PATH_ENV]: NOWHERE })).toBeUndefined();
  });

  test('the candidate list is ordered, and google-chrome comes before chromium', () => {
    const order = [...CHROME_CANDIDATES];

    expect(order[0]).toBe('/usr/bin/google-chrome');
    // A guard on the needle's presence, because `indexOf` answers -1 for an absent name and -1 is
    // less than every real index — the assertion below would hold on a list that lost the entry.
    expect(order).toContain('/usr/bin/chromium');
    expect(order.indexOf('/usr/bin/google-chrome')).toBeLessThan(
      order.indexOf('/usr/bin/chromium'),
    );
  });
});

describe('launchFoundChrome', () => {
  test('refuses by name when there is no browser, naming every path it tried', async () => {
    const thrown = await launchFoundChrome({ [CHROME_PATH_ENV]: NOWHERE }, 1_000).catch(
      (error: unknown) => error,
    );

    expect((thrown as { code?: string }).code).toBe('X_CDP_BROWSER_MISSING');
    expect((thrown as { cause?: string }).cause).toContain('/usr/bin/google-chrome');
    expect((thrown as { fix?: string }).fix).toContain(CHROME_PATH_ENV);
  });
});

describe('chromeLaunchFlags', () => {
  test('the profile never asks the OS keyring for its cookie key', () => {
    // Measured on this repo's Linux box, a throwaway profile, a plain `Page.navigate` to a local
    // server: without `--password-store=basic` the FIRST navigation of every launch stalled 7-25 s
    // — Chrome asks the Secret Service over D-Bus for the key that encrypts its cookie store and
    // waits out a D-Bus timeout when no keyring answers — and 80-145 ms with it. A 30 s CDP deadline
    // sat on the far side of that stall, which is the intermittent `X_CDP_TIMEOUT` a full e2e run
    // reported for suites that passed alone. `--use-mock-keychain` is the same question on macOS.
    const flags = chromeLaunchFlags('/tmp/profile');

    expect(flags).toContain('--password-store=basic');
    expect(flags).toContain('--use-mock-keychain');
    expect(flags).toContain('--user-data-dir=/tmp/profile');
    // The page to open stays LAST: Chrome reads a trailing non-flag argument as the url.
    expect(flags.at(-1)).toBe('about:blank');
  });
});

describe('launchChrome', () => {
  test('keeps draining stderr after the endpoint, so a chatty browser never blocks on a full pipe', async () => {
    // A pipe nobody reads fills, and the browser's next write past it BLOCKS the thread doing it.
    // 16 MB and not 64 KB: Bun's stream buffers well beyond the kernel pipe (256 KB passed with the
    // reader released), and 16 MB stalled the undrained launcher on every run while taking ~200 ms
    // drained. The fake writes it after its endpoint, then leaves a marker only a drained run reaches.
    const dir = await mkdtemp(join(tmpdir(), 'x-launch-drain-'));
    const marker = join(dir, 'done');
    const fake = join(dir, 'chrome');
    await writeFile(
      fake,
      `#!/bin/sh\necho 'DevTools listening on ws://127.0.0.1:1/devtools/browser/x' >&2\n` +
        `head -c 16777216 /dev/zero | tr '\\0' 'x' >&2\ntouch '${marker}'\nsleep 5\n`,
      'utf8',
    );
    await chmod(fake, 0o755);
    const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
    try {
      let reached = false;
      for (let i = 0; i < 40 && !reached; i += 1) {
        reached = await Bun.file(marker).exists();
        if (!reached) await Bun.sleep(50);
      }
      expect(reached).toBe(true);
    } finally {
      launched.close();
      await rm(dir, { recursive: true, force: true });
    }
  });
});
