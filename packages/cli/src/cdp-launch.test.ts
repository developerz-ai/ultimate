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
  /** A fake browser: a shell script, written executable into a throwaway directory. */
  const fakeBrowser = async (script: string): Promise<{ fake: string; dir: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'x-launch-fake-'));
    const fake = join(dir, 'chrome');
    await writeFile(fake, `#!/bin/bash\n${script}`, 'utf8');
    await chmod(fake, 0o755);
    return { fake, dir };
  };

  /** Answer the launcher's first call over the pipe: read one NUL-ended message, reply to id 1. */
  const ANSWER = `read -r -d '' _ <&3\nprintf '{"id":1,"result":{"product":"Fake"}}\\0' >&4\n`;

  test('is ready once the browser answers over its pipe, after 16 MB of stderr', async () => {
    // 16 MB of stderr BEFORE the answer: a launcher that read stderr only until some line, then
    // stopped, stalled here on every run (measured when the endpoint was read off stderr). Named
    // for what it proves — readiness past a chatty stderr — and NOT for the drain: a launcher that
    // never touches stderr also passes, because Bun buffers an unread pipe itself. The drain is
    // asserted by the two cause tests below, which read the tail it keeps.
    const { fake, dir } = await fakeBrowser(
      `head -c 16777216 /dev/zero | tr '\\0' 'x' >&2\n${ANSWER}sleep 5\n`,
    );
    try {
      const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
      launched.close();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a browser that dies before answering is X_CDP_LAUNCH_FAILED quoting its own stderr', async () => {
    const { fake, dir } = await fakeBrowser(
      `echo 'error while loading shared libraries: libnss3.so' >&2\nexit 127\n`,
    );
    try {
      const error = await launchChrome({ executable: fake, timeoutMs: 5_000 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
      expect((error as { cause: string }).cause).toContain('libnss3.so');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // A browser that neither answers nor prints nor exits — a GUI prompt, a wedged process. The
  // per-call deadline is what ends it; no read of stderr or of the pipe is ever waited on.
  test('a browser that hangs in silence is X_CDP_LAUNCH_FAILED once the deadline passes', async () => {
    const { fake, dir } = await fakeBrowser('exec sleep 30\n');
    try {
      const started = performance.now();
      const error = await launchChrome({ executable: fake, timeoutMs: 300 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
      expect((error as { cause: string }).cause).toContain('printed nothing');
      // The deadline plus the bounded exit/drain grace, never the process's 30 s.
      expect(performance.now() - started).toBeLessThan(5_000);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The launcher read the tail the moment the pipe ended, and nothing ordered the stderr reader
  // before that: a browser whose reply pipe closes before its last stderr line lands was reported
  // as "printed nothing". Forced here by closing the pipe FIRST and writing the reason after.
  test('the stderr a dying browser writes after its pipe closes still reaches the cause', async () => {
    const { fake, dir } = await fakeBrowser(
      `exec 4>&-\nsleep 0.3\necho 'error while loading shared libraries: libnss3.so' >&2\nexit 127\n`,
    );
    try {
      const error = await launchChrome({ executable: fake, timeoutMs: 5_000 }).catch(
        (e: unknown) => e,
      );
      expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
      expect((error as { cause: string }).cause).toContain('libnss3.so');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
