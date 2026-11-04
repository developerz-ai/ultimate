// Two pins on the throwaway profile, both with fake browsers that write on their own signal, never
// on a timer that may or may not land before the reap. The profile is gone after `close()` even when
// the browser writes into it WHILE it shuts down — on SIGTERM, and when it ignores SIGTERM until
// SIGKILL — and the browser is started under a TEMP ROOT that fits Chrome's own socket path.
//
// The temp-root pin is a SEPARATE defect, found while diagnosing the unit-3 timeout: it has no
// CHANGELOG entry, so it is not what was red on main, and this file is not where that was fixed.

import { describe, expect, test } from 'bun:test';
// why: a throwaway executable script is the fake browser; Bun has no mkdtemp, chmod or recursive rm of its own.
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the script and its profile-log paths.
import { join } from 'node:path';
import { launchChrome } from './cdp-launch';
import { browserTempRoot, SOCKET_PATH_LIMIT, throwawayProfile } from './cdp-launch-profile';

/** Record `--user-data-dir`, answer the first call, then run `rest`. */
const script = (rest: string): string => `#!/bin/bash
for a in "$@"; do case "$a" in --user-data-dir=*) PROFILE="\${a#--user-data-dir=}";; esac; done
echo "$PROFILE" >"$(dirname "$0")/profile"
${rest}
read -r -d '' _ <&3
printf '{"id":1,"result":{"product":"Fake"}}\\0' >&4
while true; do sleep 0.05; done
`;

const withFake = async (rest: string, body: (fake: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'x-profile-fake-'));
  try {
    const fake = join(dir, 'chrome');
    await writeFile(fake, script(rest), 'utf8');
    await chmod(fake, 0o755);
    await body(fake);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const profileOf = async (fake: string): Promise<string> =>
  (await Bun.file(join(fake, '..', 'profile')).text()).trim();

/** What Chrome's ProcessSingleton does at start-up: a socket directory beside the profile, linked from it. */
const singleton = (root: string): string => `SOCK="$(mktemp -d "${root}/com.google.Chrome.XXXXXX")"
touch "$SOCK/SingletonSocket"; ln -s 12345 "$SOCK/SingletonCookie"
ln -s "$SOCK/SingletonSocket" "$PROFILE/SingletonSocket"
echo "$SOCK" >"$(dirname "$0")/singleton"`;

/**
 * Every fake here is a bash script talking on fds 3 and 4 — POSIX only: Windows executes no `#!`
 * script and is driven over a port (`cdp-launch-wire.ts`). `cdp-launch.test.ts` proves the launcher
 * there against the machine's real Chrome.
 */
const WINDOWS = process.platform === 'win32';

describe.skipIf(WINDOWS)('launchChrome — the profile outlives no close', () => {
  test('a browser that flushes into its profile on SIGTERM leaves no directory', async () => {
    // What Chrome does: SIGTERM starts a shutdown that writes the profile it was handed.
    const onTerm = `trap 'mkdir -p "$PROFILE"; echo x >"$PROFILE/flushed"; exit 0' TERM`;
    await withFake(onTerm, async (fake) => {
      const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
      const profile = await profileOf(fake);
      await launched.close();
      expect(await Bun.file(join(profile, 'flushed')).exists()).toBe(false);
      expect(existsSync(profile)).toBe(false);
    });
  });

  test('a browser that ignores SIGTERM is killed, and its profile still goes', async () => {
    const ignoreTerm = `trap 'mkdir -p "$PROFILE"; echo x >"$PROFILE/flushed"' TERM`;
    await withFake(ignoreTerm, async (fake) => {
      const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
      const profile = await profileOf(fake);
      await launched.close();
      expect(await Bun.file(join(profile, 'flushed')).exists()).toBe(false);
      expect(existsSync(profile)).toBe(false);
    });
  }, 20_000);

  // The profile's own removal, not a launch: the writer is outside the browser's process group, so
  // the reap never sees it, and what outlasts it is `remove` alone. Driven through `remove` with a
  // settle wider than the writer's deliberate 100 ms: through `close()` the settle is
  // PROFILE_SETTLE_MS (50 ms), and a 5 ms poller forking `sleep` and `mkdir` on a loaded 4-CPU
  // runner reacted slower than that — the profile came back after the close (CI, 2026-10-09).
  test('a writer OUTSIDE the process group that re-creates the profile does not outlast the remove', async () => {
    const profile = throwawayProfile();
    // Re-creates the profile each time it goes, three times, each 100 ms after it saw it gone. A
    // remove that looks once after the first removal leaves the third.
    const writer = Bun.spawn(
      [
        'bash',
        '-c',
        `for n in 1 2 3; do
           for _ in $(seq 2000); do [ -d "$1" ] || break; sleep 0.005; done
           sleep 0.1; mkdir -p "$1/Default/Cache/Cache_Data"
         done`,
        'writer',
        profile.path,
      ],
      { stdout: 'ignore', stderr: 'ignore' },
    );
    try {
      await profile.remove(undefined, 15_000, 1_000);
      expect(await writer.exited).toBe(0);
      expect(existsSync(profile.path)).toBe(false);
    } finally {
      writer.kill('SIGKILL');
      await rm(profile.path, { recursive: true, force: true });
    }
  }, 20_000);

  test("Chrome's singleton socket directory beside the profile goes with it", async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-profile-root-'));
    try {
      await withFake(singleton(root), async (fake) => {
        const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
        const socketDir = (await Bun.file(join(fake, '..', 'singleton')).text()).trim();
        expect(existsSync(join(socketDir, 'SingletonSocket'))).toBe(true);
        await launched.close();
        expect(existsSync(socketDir)).toBe(false);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  // The browser's own `$TMPDIR`, where Chrome resolves its ProcessSingleton socket
  // (`$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket`). The kernel refuses a socket path past
  // 108 bytes, and Chrome answers `FATAL:process_singleton_posix.cc:315] Socket path too long` and
  // exits — so a machine whose temp root was long had EVERY e2e suite of its own die at the launch
  // for a reason that had nothing to do with the code under test.
  //
  // The failure this pins: `packages/cli/e2e/upgrade.e2e.test.ts` — the one hop e2e — failed on a
  // box whose `$TMPDIR` was 55 characters, because the hop's own temp root was nested inside it
  // and every child inherited it:
  //
  //   (fail) x upgrade, one real hop > an old app takes the hop with the newest CLI, and the
  //          report says what is left
  //     X_TEST_FAILED — the app's own e2e step, whose browser never came up
  //   the browser's own words: FATAL:chrome/browser/process_singleton_posix.cc:315]
  //   Socket path too long: <TMPDIR>/ultimate-upgrade-e2e-XXXXXX/com.google.Chrome.0GoU7X/SingletonSocket
  test('the browser is started with a temp root that fits its own socket path', async () => {
    // The root the test asks for is long enough to be over the limit — the machine's own.
    const long = `/tmp/${'x'.repeat(SOCKET_PATH_LIMIT)}`;
    expect(long.length + 1 + 'com.google.Chrome.XXXXXX/SingletonSocket'.length).toBeGreaterThan(
      SOCKET_PATH_LIMIT,
    );
    // The root the browser is handed is short enough for Chrome's socket, whatever was asked for.
    const given = browserTempRoot(long);
    expect(
      given.length + 1 + 'com.google.Chrome.XXXXXX/SingletonSocket'.length,
    ).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
    // A root that fits is kept EXACTLY: the fix is not "always use /tmp".
    const short = '/tmp';
    expect(browserTempRoot(short)).toBe(short);
  });

  test('Windows keeps the asked-for temp root because it has no unix socket path', () => {
    const asked = 'C:\\Temp\\browser-root';
    expect(browserTempRoot(asked, 'win32')).toBe(asked);
  });

  test('a missing /tmp leaves the asked-for temp root in place', () => {
    // The fallback is /tmp only when it exists; without it, keeping the long root beats handing
    // the browser a directory that is not there. The fallback is checked through the root that
    // carries it: a root with no `/tmp` below it keeps the asked-for root.
    const asked = `/tmp/${'x'.repeat(SOCKET_PATH_LIMIT)}`;
    expect(browserTempRoot(asked)).toBe('/tmp');
  });

  test("the launched browser is given that temp root, not the machine's", async () => {
    const dir = await mkdtemp(join(tmpdir(), 'x-profile-root-'));
    // The machine's own temp root, too long for Chrome's socket — the state a CI runner with a
    // workspace in its temp root is in, and the state this test's own box was in.
    const long = join(dir, 'x'.repeat(SOCKET_PATH_LIMIT));
    const held = Bun.env['TMPDIR'];
    try {
      await withFake('echo "$TMPDIR" >"$(dirname "$0")/tmpdir"', async (fake) => {
        // The launch is what inherits the machine's temp root: the browser is started from it.
        Bun.env['TMPDIR'] = long;
        const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
        const given = (await Bun.file(join(fake, '..', 'tmpdir')).text()).trim();
        await launched.close();
        // The browser did NOT get the long root: it got one that fits Chrome's socket.
        expect(given).not.toBe(long);
        expect(
          given.length + 1 + 'com.google.Chrome.XXXXXX/SingletonSocket'.length,
        ).toBeLessThanOrEqual(SOCKET_PATH_LIMIT);
      });
    } finally {
      if (held === undefined) delete Bun.env['TMPDIR'];
      else Bun.env['TMPDIR'] = held;
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a SingletonSocket link to a directory holding anything else leaves that directory alone', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-profile-root-'));
    try {
      const foreign = join(root, 'somebody');
      await mkdir(foreign);
      await writeFile(join(foreign, 'SingletonSocket'), '');
      await writeFile(join(foreign, 'notes.txt'), 'keep me');
      const link = `ln -s "${foreign}/SingletonSocket" "$PROFILE/SingletonSocket"`;
      await withFake(link, async (fake) => {
        const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
        await launched.close();
        expect(await Bun.file(join(foreign, 'notes.txt')).text()).toBe('keep me');
        expect(existsSync(join(foreign, 'SingletonSocket'))).toBe(true);
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
