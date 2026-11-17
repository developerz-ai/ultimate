// What the launcher does with a browser: none, one that cannot start, fakes over the pipe, and the
// machine's real Chrome. Which browser a run gets (the candidate order) is `cdp-launch-find.test.ts`.

import { describe, expect, test } from 'bun:test';
// why: whether the profile directory outlived the close is a filesystem question Bun has no sync answer to.
import { existsSync } from 'node:fs';
// why: a throwaway executable script is the fake browser; Bun has no mkdtemp, chmod or recursive rm of its own.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the script and marker paths.
import { join } from 'node:path';
import {
  BROWSER_LIFETIME_MS,
  CHROME_PATH_ENV,
  CHROME_RESTRICTED_PORTS,
  CLOSE_GRACE_MS,
  chromeCandidates,
  chromeLaunchFlags,
  findChrome,
  launchChrome,
  launchFoundChrome,
} from './cdp-launch';
import { launchAttempt } from './cdp-launch-attempt';
import { LAUNCH_TEST_MS } from './cdp-launch-ready';
import type { CdpWire } from './cdp-launch-wire';

/**
 * The fakes below are bash scripts that talk on fds 3 and 4: Windows runs neither a `#!` script nor
 * that pipe (`cdp-launch-wire.ts`). There the launcher is proved against the machine's real Chrome
 * — the last block of this file — which is what a fake stands in for everywhere else.
 */
const WINDOWS = process.platform === 'win32';

const NOWHERE = '/nonexistent/definitely-not-a-browser';

describe('launchFoundChrome', () => {
  test(
    'refuses by name when there is no browser, naming every path it tried',
    async () => {
      const thrown = await launchFoundChrome({ [CHROME_PATH_ENV]: NOWHERE }, 1_000).catch(
        (error: unknown) => error,
      );

      expect((thrown as { code?: string }).code).toBe('X_CDP_BROWSER_MISSING');
      // Rendered as JSON, so a Windows path's backslashes arrive doubled: compare like with like.
      const first = JSON.stringify(chromeCandidates(process.platform, process.env)[0]).slice(1, -1);
      expect((thrown as { cause?: string }).cause).toContain(first);
      expect((thrown as { fix?: string }).fix).toContain(CHROME_PATH_ENV);
    },
    LAUNCH_TEST_MS,
  );
});

describe('chromeLaunchFlags', () => {
  // Round 3: an e2e server on `port: 0` drew 3659, which Chrome refuses to load (ERR_UNSAFE_PORT),
  // and a ui e2e suite went red on the remote gate. A launch that serves its own pages allows them;
  // the default launch, and `pdf()`'s in production, keeps Chrome's refusal.
  test('a launch handed allowed ports passes them; the default keeps the restriction', () => {
    expect(chromeLaunchFlags('/tmp/profile').some((flag) => flag.includes('allowed-ports'))).toBe(
      false,
    );
    const flags = chromeLaunchFlags('/tmp/profile', 'pipe', false, CHROME_RESTRICTED_PORTS);
    const allowed = flags.find((flag) => flag.startsWith('--explicitly-allowed-ports='));
    expect(allowed?.split('=')[1]?.split(',')).toContain('3659');
    expect(CHROME_RESTRICTED_PORTS.every((port) => port >= 1024)).toBe(true);
  });

  test('the profile never asks the OS keyring for its cookie key', () => {
    // Measured on this repo's Linux box, a throwaway profile, a plain `Page.navigate` to a local
    // server: without `--password-store=basic` the FIRST navigation of every launch stalled 7-25 s
    // — Chrome asks the Secret Service over D-Bus for the key that encrypts its cookie store and
    // waits out a D-Bus timeout when no keyring answers — and 80-145 ms with it. A 30 s CDP deadline
    // sat on the far side of that stall, which is the intermittent `X_CDP_TIMEOUT` a full e2e run
    // reported for suites that passed alone. `--use-mock-keychain` is the same question on macOS.
    const flags = chromeLaunchFlags('/tmp/profile');
    // The sandboxed launch (`pdf()`'s) drops the one switch and keeps the rest.
    const sandboxed = chromeLaunchFlags('/tmp/profile', 'pipe', true);
    expect(sandboxed).not.toContain('--no-sandbox');
    expect(sandboxed).toContain('--disable-dev-shm-usage');
    expect(flags).toContain('--no-sandbox');

    expect(flags).toContain('--password-store=basic');
    expect(flags).toContain('--use-mock-keychain');
    expect(flags).toContain('--user-data-dir=/tmp/profile');
    // The page to open stays LAST: Chrome reads a trailing non-flag argument as the url.
    expect(flags.at(-1)).toBe('about:blank');
  });
});

describe('launchChrome — a binary that cannot be started', () => {
  // Bun throws from `spawn` itself for a path that is not there or not a format the OS executes —
  // every fake below, on Windows. That throw escaped as a bare ENOENT, not X_CDP_LAUNCH_FAILED.
  test(
    'is X_CDP_LAUNCH_FAILED naming why, never a bare spawn error',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'x-launch-none-'));
      try {
        const error = await launchChrome({
          executable: join(dir, 'no-such-browser'),
          timeoutMs: 1_000,
        }).catch((e: unknown) => e);
        expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
        const { cause, meta } = error as { cause: string; meta?: Record<string, unknown> };
        expect(cause).toContain('could not be started');
        // Its own `why`: `closed` reads "it ran and was killed", which is not what happened.
        expect(cause).not.toContain('was killed');
        const never = {
          why: 'spawn',
          exitCode: null,
          stderr: '',
          // The platform's own words for a missing binary: `ENOENT` on POSIX, "Executable not found"
          // from Bun on Windows (the windows job, #664). The test is about the shape, not the errno.
          detail: expect.stringMatching(/ENOENT|Executable not found/),
        };
        expect(meta?.['attempts']).toMatchObject([never, never]);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_MS,
  );
});

describe.skipIf(WINDOWS)('launchChrome', () => {
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

  test(
    'is ready once the browser answers over its pipe, after 16 MB of stderr',
    async () => {
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
        await launched.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_MS,
  );

  test(
    'close() resolves once the process has exited — at once when SIGTERM ends it',
    async () => {
      const { fake, dir } = await fakeBrowser(`${ANSWER}sleep 30\n`);
      try {
        const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
        const started = performance.now();
        await launched.close();
        expect(performance.now() - started).toBeLessThan(CLOSE_GRACE_MS);
        // Idempotent: the second call is the same wait, already over.
        await launched.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_MS,
  );

  // The spawn's own bound (`lifetimeMs`, the spawn-timeout guard): a caller that crashed or a hook
  // Bun cut short never calls `close()`, and the browser must not outlive every reason it ran for.
  test(
    'a browser nobody closes is killed by the OS at its lifetime, SIGTERM ignored or not',
    async () => {
      const { fake, dir } = await fakeBrowser(
        `trap '' TERM\n${ANSWER}while true; do sleep 1; done\n`,
      );
      try {
        const launched = await launchChrome({
          executable: fake,
          timeoutMs: 5_000,
          lifetimeMs: 400,
        });
        const answer = await launched.connection
          .send('Browser.getVersion', {}, undefined, 3_000)
          .then(
            () => 'answered',
            (error: unknown) => (error as { code?: string }).code,
          );
        // Never answered past the first call, and the wire closed on the kill: not the 3 s deadline.
        expect(answer).toBe('X_CDP_CALL_FAILED');
        await launched.close();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_MS,
  );

  test(
    'a lifetime that is not a positive count is refused before a process starts',
    async () => {
      const error = await launchChrome({
        executable: NOWHERE,
        timeoutMs: 5_000,
        lifetimeMs: Number.NaN,
      }).catch((e: unknown) => e);
      expect(error).toBeUltimateError('X_INVARIANT');
    },
    LAUNCH_TEST_MS,
  );

  test(
    'close() kills a browser that ignores SIGTERM, and still resolves — bounded',
    async () => {
      const { fake, dir } = await fakeBrowser(
        `trap '' TERM\n${ANSWER}while true; do sleep 1; done\n`,
      );
      try {
        const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
        const started = performance.now();
        await launched.close();
        const took = performance.now() - started;
        expect(took).toBeGreaterThanOrEqual(CLOSE_GRACE_MS - 100);
        expect(took).toBeLessThan(CLOSE_GRACE_MS * 2 + 1_000);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_MS,
  );

  test(
    'a browser that dies before answering is X_CDP_LAUNCH_FAILED quoting its own stderr',
    async () => {
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
    },
    LAUNCH_TEST_MS,
  );

  // A browser that neither answers nor prints nor exits — a GUI prompt, a wedged process. The
  // per-call deadline is what ends it; no read of stderr or of the pipe is ever waited on.
  test(
    'a browser that hangs in silence is X_CDP_LAUNCH_FAILED once the deadline passes',
    async () => {
      const { fake, dir } = await fakeBrowser('exec sleep 30\n');
      try {
        const started = performance.now();
        const error = await launchChrome({
          executable: fake,
          timeoutMs: 300,
          launchTimeoutMs: 300,
        }).catch((e: unknown) => e);
        expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
        expect((error as { cause: string }).cause).toContain('printed nothing');
        // Two starts, each its deadline plus a bounded reap and drain — never the process's 30 s.
        expect(performance.now() - started).toBeLessThan(5_000);
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
    LAUNCH_TEST_MS,
  );

  // The launcher read the tail the moment the pipe ended, and nothing ordered the stderr reader
  // before that: a browser whose reply pipe closes before its last stderr line lands was reported
  // as "printed nothing". Forced here by closing the pipe FIRST and writing the reason after.
  test(
    'the stderr a dying browser writes after its pipe closes still reaches the cause',
    async () => {
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
    },
    LAUNCH_TEST_MS,
  );

  // A NaN deadline would be `setTimeout(fn, 0)`: every start cancelled 1 ms in and a healthy
  // browser reported silent. Screened before a process is spawned, so a bad option fails by name.
  test(
    'a NaN launch deadline is X_INVARIANT, never a 1 ms timer',
    async () => {
      const error = await launchChrome({
        executable: 'unused',
        timeoutMs: 5_000,
        launchTimeoutMs: Number.NaN,
      }).catch((e: unknown) => e);
      expect(error).toBeUltimateError('X_INVARIANT');
      expect((error as { cause: string }).cause).toContain('launchTimeoutMs');
    },
    LAUNCH_TEST_MS,
  );
});

const realChrome = await findChrome(process.env);
/** `ci.yml` sets it, so a runner that lost its browser fails here instead of skipping in silence. */
const browserRequired = process.env['E2E_BROWSER_REQUIRED'] === '1';

describe.skipIf(realChrome === undefined && !browserRequired)(
  'launchChrome — this machine’s Chrome',
  () => {
    // The pipe on Windows is skipped, not failed: the parent cannot hold Chrome's fds 3 and 4 there,
    // which is why `defaultWire('win32')` is the port.
    const wires: CdpWire[] = process.platform === 'win32' ? ['port'] : ['pipe', 'port'];

    test.each(wires)(
      'over the %s, it answers, closes, and leaves no process holding its profile',
      async (wire) => {
        if (realChrome === undefined)
          expect.unreachable('E2E_BROWSER_REQUIRED=1 and no Chrome was found');
        let profile = '';
        const started = await launchAttempt({
          executable: realChrome,
          flags: (dir) => {
            profile = dir;
            return chromeLaunchFlags(dir, wire);
          },
          wire,
          timeoutMs: 10_000,
          launchTimeoutMs: 60_000,
          lifetimeMs: BROWSER_LIFETIME_MS,
        });
        if (!started.ok) expect.unreachable(`no launch: ${JSON.stringify(started.failure)}`);
        try {
          const version = await started.browser.connection.send('Browser.getVersion');
          expect(JSON.stringify(version)).toContain('product');
        } finally {
          await started.browser.close();
        }
        // A profile still there is a browser process — on Windows, an orphaned child — holding it.
        expect(existsSync(profile)).toBe(false);
      },
      LAUNCH_TEST_MS,
    );
  },
);
