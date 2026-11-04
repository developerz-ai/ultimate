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
import { browserTempRoot, MAX_BROWSER_TEMP_ROOT, throwawayProfile } from './cdp-launch-profile';

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
  // Under `/tmp` and not under `tmpdir()`: a case may make `TMPDIR` long on purpose, and the
  // fake browser's own scratch directory is not the subject of that case.
  const dir = await mkdtemp(join('/tmp', 'x-profile-fake-'));
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
    const root = browserTempRoot();
    if (root === undefined) return expect.unreachable('this machine has no usable temp root');
    const profile = throwawayProfile(root);
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

describe("the browser's temp root", () => {
  // Chrome's ProcessSingleton puts its socket in `$TMPDIR`, not in the profile:
  // `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket`, and the kernel caps a UNIX socket path at
  // 108 bytes. Measured on this box: a root of 60 characters launches, 66 does not — Chrome dies
  // at start-up with `FATAL: Socket path too long` and the launcher reported that as
  // `X_CDP_LAUNCH_FAILED`, naming the browser rather than the cause. Every browser-backed e2e
  // suite on a machine whose `TMPDIR` is 64 characters or longer failed that way.
  test('the root the browser is given is short enough for its singleton socket', () => {
    const root = browserTempRoot();
    // A machine with no usable root at all refuses the launch; it is not a root to hand over.
    if (root === undefined) return expect.unreachable('this machine has no usable temp root');
    expect(root.length).toBeLessThanOrEqual(MAX_BROWSER_TEMP_ROOT);
    // The socket path Chrome builds from it, counted as Chrome counts it.
    expect(`${root}/com.google.Chrome.XXXXXX/SingletonSocket`.length).toBeLessThanOrEqual(108);
  });

  test('the profile lives under the root the browser is given', () => {
    // The profile and the singleton socket must share one root: the socket path is the limit, and
    // a profile under a different root would leave the socket where the limit is.
    const root = browserTempRoot();
    if (root === undefined) return expect.unreachable('this machine has no usable temp root');
    const profile = throwawayProfile(root);
    try {
      expect(profile.path.startsWith(profile.tempRoot)).toBe(true);
      expect(profile.tempRoot.length).toBeLessThanOrEqual(MAX_BROWSER_TEMP_ROOT);
    } finally {
      void profile.remove(undefined, 1_000);
    }
  });
});

// Which candidates the root is chosen from is a parameter of `browserTempRoot()`, so every
// branch of the rule can be asked about roots this process does not have.
describe("the browser's temp root — which candidate is chosen", () => {
  test('a root that is not there is refused, and the next candidate is taken', () => {
    // The existence check: a candidate that does not exist cannot be the browser's root, and the
    // answer must move on rather than hand back a path Chrome cannot use.
    const missing = join('/tmp', 'x-no-such-temp-root');
    expect(existsSync(missing)).toBe(false);
    const root = browserTempRoot([missing, '/tmp']);
    expect(root).toBe('/tmp');
  });

  test('a root that is not a directory is refused', async () => {
    // A FILE is not a temp root: Chrome makes its socket DIRECTORY in it, and a file is not one.
    const dir = await mkdtemp(join('/tmp', 'x-file-root-'));
    try {
      const file = join(dir, 'x-not-a-dir');
      await writeFile(file, 'not a directory', 'utf8');
      expect(browserTempRoot([file, '/tmp'])).toBe('/tmp');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Root ignores directory permissions, so the refusal cannot be staged at all under it.
  test.skipIf(process.getuid?.() === 0)('a root that cannot be written in is refused', async () => {
    // The writability the docblock promises: existence alone is not enough, because a root the
    // browser cannot write in is a profile it cannot make and a socket it cannot create.
    const dir = await mkdtemp(join('/tmp', 'x-readonly-root-'));
    try {
      await chmod(dir, 0o500);
      expect(browserTempRoot([dir, '/tmp'])).toBe('/tmp');
    } finally {
      await chmod(dir, 0o700);
      await rm(dir, { recursive: true, force: true });
    }
  });

  test('a root that is too long is refused, and the browser is never given one', () => {
    // The length cap: a root over `MAX_BROWSER_TEMP_ROOT` cannot hold Chrome's socket, so it is
    // never the answer — not even when it is the only candidate there is. The old fallback
    // returned this very root, and Chrome died at start-up with `FATAL: Socket path too long`.
    const long = '/x'.repeat(MAX_BROWSER_TEMP_ROOT);
    expect(long.length).toBeGreaterThan(MAX_BROWSER_TEMP_ROOT);
    expect(browserTempRoot([long])).toBeUndefined();
  });

  test('with no usable candidate the answer is no root at all, never a refused one', () => {
    // No candidate is usable: there is no root the browser can be given, and the answer says so.
    // The old fallback returned the refused root itself — the very path over the limit that
    // kills Chrome at start-up.
    const long = '/x'.repeat(MAX_BROWSER_TEMP_ROOT + 10);
    const missing = join('/tmp', 'x-no-such-temp-root');
    expect(browserTempRoot([long, missing])).toBeUndefined();
  });
});

// The cases below need a POSIX temp root and a POSIX shell: `/tmp` and a `#!` script. Windows
// executes neither, and `os.tmpdir()` there reads `TEMP`, not `TMPDIR` — the cap is a POSIX fact.
describe.skipIf(WINDOWS)("the browser's temp root — the child, on POSIX", () => {
  test('a long TMPDIR does not decide the root the browser is given', async () => {
    // The process's own `TMPDIR` is what the defect came from, so the rule is asked with one:
    // a root long enough to break Chrome, and the answer must still be short enough.
    // The root is long BY CONSTRUCTION — a name of `MAX_BROWSER_TEMP_ROOT` characters under `/tmp`
    // — and it EXISTS: a candidate that does not exist is refused for that reason, and the case
    // would then prove nothing about the length cap. It is the LENGTH that must reject it.
    const previous = process.env['TMPDIR'];
    const long = await mkdtemp(join('/tmp', 'x'.repeat(MAX_BROWSER_TEMP_ROOT)));
    try {
      process.env['TMPDIR'] = long;
      // The premise, asserted: a root this long cannot hold Chrome's socket.
      expect(long.length).toBeGreaterThan(MAX_BROWSER_TEMP_ROOT);
      expect(`${long}/com.google.Chrome.XXXXXX/SingletonSocket`.length).toBeGreaterThan(108);
      // ...and the answer is short anyway.
      const root = browserTempRoot();
      if (root === undefined) return expect.unreachable('no usable temp root on this machine');
      expect(root.length).toBeLessThanOrEqual(MAX_BROWSER_TEMP_ROOT);
      expect(`${root}/com.google.Chrome.XXXXXX/SingletonSocket`.length).toBeLessThanOrEqual(108);
    } finally {
      if (previous === undefined) delete process.env['TMPDIR'];
      else process.env['TMPDIR'] = previous;
      await rm(long, { recursive: true, force: true });
    }
  });

  test("the BROWSER runs under that root, not under the process's", async () => {
    // The rule is about the CHILD: Chrome puts its socket in `$TMPDIR`, so a browser that
    // inherits a long `TMPDIR` dies at start-up with `FATAL: Socket path too long` before it
    // announces a DevTools endpoint. A fake browser that prints the `TMPDIR` it was given is the
    // direct witness — the mechanism, not a proxy for it.
    let seen = '';
    await withFake('echo "TMPDIR=$TMPDIR" >"$(dirname "$0")/tempdir"', async (fake) => {
      const launched = await launchChrome({ executable: fake, timeoutMs: 5_000 });
      seen = (await Bun.file(join(fake, '..', 'tempdir')).text()).trim();
      await launched.close();
    });
    const root = seen.replace('TMPDIR=', '');
    // The root the browser was given is short enough for the socket Chrome builds from it — and
    // it is the browser's OWN root, not the one this process inherited.
    expect(root.length).toBeLessThanOrEqual(MAX_BROWSER_TEMP_ROOT);
    expect(`${root}/com.google.Chrome.XXXXXX/SingletonSocket`.length).toBeLessThanOrEqual(108);
  }, 20_000);

  test('a browser under a LONG TMPDIR still gets a root that fits', async () => {
    // The defect, reproduced end to end: the PROCESS's temp root is long — Chrome's socket path
    // is `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket` and a UNIX socket path is capped at
    // 108 bytes — so the browser must be given a root of its own. A subprocess carries the long
    // `TMPDIR`, because `Bun.spawn` snapshots the environment at process start and a test cannot
    // hand its own child a different one.
    // Long enough to break Chrome: the socket path is `$TMPDIR/com.google.Chrome.XXXXXX/SingletonSocket`
    // and a UNIX socket path is capped at 108 bytes, so a root over 63 characters cannot hold it.
    const long = await mkdtemp(join('/tmp', 'x'.repeat(MAX_BROWSER_TEMP_ROOT)));
    const dir = await mkdtemp(join('/tmp', 'x-long-fake-'));
    try {
      const fake = join(dir, 'chrome');
      await writeFile(fake, script('echo "TMPDIR=$TMPDIR" >"$(dirname "$0")/tempdir"'), 'utf8');
      await chmod(fake, 0o755);
      const source = [
        `import { launchChrome } from ${JSON.stringify(join(import.meta.dir, 'cdp-launch'))};`,
        `const launched = await launchChrome({ executable: ${JSON.stringify(fake)}, timeoutMs: 5_000 });`,
        `console.log((await Bun.file(${JSON.stringify(join(dir, 'tempdir'))}).text()).trim());`,
        'await launched.close();',
      ].join('\n');
      const run = Bun.spawnSync([process.execPath, '-e', source], {
        env: { ...process.env, TMPDIR: long },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      });
      expect(run.exitCode).toBe(0);
      const root = run.stdout.toString().trim().replace('TMPDIR=', '');
      // The long root the process was given is long enough to break Chrome's socket...
      expect(long.length).toBeGreaterThan(MAX_BROWSER_TEMP_ROOT);
      // ...and the browser was given a short one anyway.
      expect(root.length).toBeLessThanOrEqual(MAX_BROWSER_TEMP_ROOT);
      expect(`${root}/com.google.Chrome.XXXXXX/SingletonSocket`.length).toBeLessThanOrEqual(108);
    } finally {
      await rm(long, { recursive: true, force: true });
      await rm(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
