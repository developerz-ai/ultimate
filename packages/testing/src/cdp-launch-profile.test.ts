// The throwaway profile is gone after `close()` even when the browser writes into it WHILE it shuts
// down — on SIGTERM, and when it ignores SIGTERM until SIGKILL. Fake browsers, deterministic: each
// writes on its own signal, never on a timer that may or may not land before the reap.

import { describe, expect, test } from 'bun:test';
// why: a throwaway executable script is the fake browser; Bun has no mkdtemp, chmod or recursive rm of its own.
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the script and its profile-log paths.
import { join } from 'node:path';
import { launchChrome } from './cdp-launch';

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

  test('a writer OUTSIDE the process group that re-creates the profile does not outlast the close', async () => {
    // Its own process group (`set -m`), so the group reap cannot see it — Chrome's crashpad
    // handler is one — and it re-creates the profile each time it goes, three times. A close that
    // removes once after the reap leaves the third.
    const late = `set -m
( for n in 1 2 3; do
    for _ in $(seq 400); do [ -d "$PROFILE" ] || break; sleep 0.005; done
    mkdir -p "$PROFILE/Default/Cache/Cache_Data"
  done ) &
set +m`;
    await withFake(late, async (fake) => {
      const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
      const profile = await profileOf(fake);
      await launched.close();
      // Long past the writer's 5 ms poll: a profile it re-created after the close has reappeared.
      await Bun.sleep(250);
      expect(existsSync(profile)).toBe(false);
    });
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
