// One responsibility: WHICH Chrome, with which flags, and how many starts it gets — the candidate
// list, the launch deadline and the one relaunch. One start of the process is
// `cdp-launch-attempt.ts`; the connection is `cdp-connection.ts`, the page `cdp-e2e-page.ts`.

import { finiteCount } from '@ultimat3/core';
import type { CdpLaunchAttempt } from './cdp-errors';
import { CdpBrowserMissingError, CdpLaunchFailedError } from './cdp-errors';
import type { LaunchedBrowser } from './cdp-launch-attempt';
import { launchAttempt } from './cdp-launch-attempt';

export type { LaunchedBrowser } from './cdp-launch-attempt';
export { CLOSE_GRACE_MS } from './cdp-launch-attempt';

/**
 * Where a Chrome is, in the order worth trying. `CHROME_PATH` first because it is the operator's
 * answer and the only one that can be right on a machine none of the rest describes; the two
 * `/usr/bin` names after it are what GitHub-hosted `ubuntu-latest` ships, which is what lets the
 * browser-backed suite run in CI with **no download step and no new dependency**.
 */
export const CHROME_PATH_ENV = 'CHROME_PATH';
export const CHROME_CANDIDATES: readonly string[] = [
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

/** The first candidate that exists, or `undefined`. An absent browser is a SKIP, never a failure. */
export async function findChrome(
  env: Readonly<Record<string, string | undefined>>,
): Promise<string | undefined> {
  const declared = env[CHROME_PATH_ENV];
  const candidates = declared === undefined || declared === '' ? CHROME_CANDIDATES : [declared];
  for (const candidate of candidates) {
    if (await Bun.file(candidate).exists()) return candidate;
  }
  return undefined;
}

/**
 * The two flags a CONTAINER needs, regardless of which process launches Chrome: the sandbox needs
 * privileges CI (and an Ubuntu 23.10+ host with AppArmor's unprivileged-user-namespace restriction
 * — Chrome exits "No usable sandbox" there with neither) does not grant, and `/dev/shm` is 64 MB in
 * a default container, which crashes the renderer on any real page.
 *
 * Exported, and in `chromeLaunchFlags` below, so every launcher carries the SAME two. `x shot` had
 * neither while it launched through `puppeteer-core`, so a box where `x verify`'s e2e gate ran green
 * could not run `x shot` at all; since 22.0.0 it launches through `launchChrome` here.
 */
export const CONTAINER_CHROME_ARGS: readonly string[] = ['--no-sandbox', '--disable-dev-shm-usage'];

/**
 * The flags, and every one of them earns its line.
 *
 * `--headless=new` is Chrome's own headless rather than the retired shim. `--remote-debugging-pipe`
 * is the wire (`cdp-pipe.ts` says why it is not the WebSocket): no port, so two suites on one
 * machine can never collide, and nothing but this process can drive the browser. A throwaway
 * `--user-data-dir` because a run sharing a profile with a real browser inherits its cookies and
 * locks its files.
 */
export const chromeLaunchFlags = (profileDir: string): readonly string[] => [
  '--headless=new',
  '--remote-debugging-pipe',
  `--user-data-dir=${profileDir}`,
  ...CONTAINER_CHROME_ARGS,
  '--disable-gpu',
  // The cookie store's encryption key comes from the OS keyring, asked over D-Bus on the first
  // cookie access — which is the first navigation. With no keyring answering, Chrome waits out the
  // D-Bus timeout: measured 7-25 s on the first `Page.navigate` of every launch, against a 30 s CDP
  // deadline, which is the intermittent `X_CDP_TIMEOUT` of a full e2e run. A throwaway profile has
  // no secret worth a keyring. `x shot` launches through here too, so it has both.
  '--password-store=basic',
  '--use-mock-keychain',
  // Nothing here should reach the network on its own account, and a first-run bubble or an update
  // check is a page load the test did not ask for.
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  'about:blank',
];

/**
 * How long a COLD start may take before the browser is given up on. Its own number, never the
 * per-call deadline: measured 2026-10-02 over `scaffold-smoke` on free `ubuntu-latest` runners, the
 * first launch of a job cost 5-19 s more than a warm one in 11 green jobs, and the one red job was
 * still printing start-up lines when a 30 s deadline killed it. Twice that, and finite: a browser
 * that exits says so at once (its pipe closes), so only one alive and silent waits this long.
 */
export const LAUNCH_TIMEOUT_MS = 60_000;

/**
 * Starts per launch: the first, and ONE more on a fresh profile after the first was reaped. A
 * process start is the one step here whose failure can belong to the machine rather than the
 * binary — and the second start of a cold binary is a warm one. Never a loop: two starts that both
 * went unanswered are `X_CDP_LAUNCH_FAILED` carrying both.
 */
export const LAUNCH_ATTEMPTS = 2;

export interface LaunchOptions {
  readonly executable: string;
  /** Every CDP call's deadline once the browser is up. */
  readonly timeoutMs: number;
  /** The first answer's deadline, per start. Defaults to the larger of `timeoutMs` and `LAUNCH_TIMEOUT_MS`. */
  readonly launchTimeoutMs?: number | undefined;
}

/**
 * Start Chrome on a throwaway profile and answer once it has answered one CDP call. A browser that
 * dies or stays silent is started once more; twice is `X_CDP_LAUNCH_FAILED` with each start's own
 * stderr and whether it exited or was killed at the deadline.
 */
export async function launchChrome(options: LaunchOptions): Promise<LaunchedBrowser> {
  // Screened: `setTimeout(fn, NaN)` fires in 1 ms, which reports a healthy browser as silent.
  const launchTimeoutMs = finiteCount(
    'launchChrome',
    'launchTimeoutMs',
    options.launchTimeoutMs ?? Math.max(options.timeoutMs, LAUNCH_TIMEOUT_MS),
    1,
  );
  const failures: CdpLaunchAttempt[] = [];
  while (failures.length < LAUNCH_ATTEMPTS) {
    const started = await launchAttempt({
      executable: options.executable,
      flags: chromeLaunchFlags,
      timeoutMs: options.timeoutMs,
      launchTimeoutMs,
    });
    if (started.ok) return started.browser;
    failures.push(started.failure);
    // A process that outlived SIGKILL's grace still holds the machine; a second beside it is the
    // load that made the first one late.
    if (!started.reaped) break;
  }
  throw new CdpLaunchFailedError({ executable: options.executable, attempts: failures });
}

/** `findChrome` then `launchChrome`. Refuses by name when there is no browser to drive. */
export async function launchFoundChrome(
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs: number,
): Promise<LaunchedBrowser> {
  const executable = await findChrome(env);
  if (executable === undefined) throw new CdpBrowserMissingError({ tried: CHROME_CANDIDATES });
  return launchChrome({ executable, timeoutMs });
}
