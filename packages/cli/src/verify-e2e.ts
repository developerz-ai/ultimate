// What the gate's `e2e` step does around the suite in an APP: when this machine has a browser, it
// runs the suite with the e2e preload and names the app root, and the PRELOAD spawns the app — so
// the app lives in the test process, where `deploy.newBuild()` can restart it. No browser, or not an
// app: the suite runs as before and its browser-backed cases skip — or refuse under
// `E2E_BROWSER_REQUIRED=1`. An app whose `x.verify.json` requires `e2e` and ran nothing for want of
// a browser is red by `judgeE2eBrowser`, with the command that installs one.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { CHROME_PATH_ENV, chromeCandidates, findChrome } from '@ultimat3/scraping/cdp';
import { E2E_ROOT_ENV } from '@ultimat3/testing';
import type { ExecResult } from './exec';
import type { Finding } from './output';
import { floorRequires, readVerifyFloor, VERIFY_FLOOR_FILE } from './verify-floor';
import type { StepOutcome } from './verify-step';

/**
 * The preload `bun test` is handed, beside the app's own from `bunfig.toml` — `@ultimat3/testing`'s,
 * resolved from here to the absolute path the child process loads. A FUNCTION, resolved when a run
 * needs it: at module scope it ran on every import of the registry, and a compiled `x` binary —
 * whose `/$bunfs` holds no `node_modules` — died at boot resolving a file it never uses.
 */
export const e2ePreload = (): string =>
  Bun.resolveSync('@ultimat3/testing/e2e-preload', import.meta.dir);

/** The device zone every browser-backed app e2e run uses, never the runner's ambient zone. */
export const E2E_TIME_ZONE = 'America/Los_Angeles';

export interface E2eRun {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Add the app preload and its deterministic device zone after a browser was found. */
export function appE2eRun(input: {
  readonly root: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): E2eRun {
  const [bun = 'bun', test = 'test', ...rest] = input.command;
  return {
    command: [bun, test, '--preload', e2ePreload(), ...rest],
    env: { ...input.env, [E2E_ROOT_ENV]: input.root, TZ: E2E_TIME_ZONE },
  };
}

/** Wrap one e2e `bun test` invocation: `run` receives the command and extra environment to use. */
export async function withE2eApp(
  input: {
    readonly root: string;
    readonly isApp: boolean;
    readonly command: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
    /**
     * The step's whole environment (`ctx.env ?? Bun.env`), where `CHROME_PATH` is read — the same
     * one `judgeE2eBrowser` reads, so the launch and the verdict never disagree about the browser.
     * `env` above is only the overrides the child is handed.
     */
    readonly hostEnv: Readonly<Record<string, string | undefined>>;
  },
  run: (e2e: E2eRun) => Promise<ExecResult>,
): Promise<ExecResult> {
  const chrome = input.isApp ? await findChrome(input.hostEnv) : undefined;
  if (chrome === undefined) return run({ command: input.command, env: input.env });
  return run(appE2eRun({ root: input.root, command: input.command, env: input.env }));
}

/** The floored e2e step that ran nothing because this machine has no browser to drive. */
export const E2E_BROWSER_MISSING = 'X_VERIFY_E2E_BROWSER_MISSING';

const LINUX_CHROME_DEB =
  'https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb';
const LINUX_CHROME_INSTALL = `curl -fsSLo /tmp/google-chrome.deb ${LINUX_CHROME_DEB} && sudo apt-get install -y /tmp/google-chrome.deb`;

type Env = Readonly<Record<string, string | undefined>>;

/**
 * The one command that puts a browser `findChrome` probes on this platform: Google's own `.deb`
 * lands at `/usr/bin/google-chrome` — never Ubuntu's `chromium`, a snap wrapper that cannot start
 * outside a snap cgroup (`cdp-launch-probe.ts`) — and Homebrew's cask and winget's package at the
 * paths `cdp-launch-candidates.ts` lists. Any other platform gets Linux's.
 */
export function browserInstallCommand(platform: string): string {
  if (platform === 'darwin') return 'brew install --cask google-chrome';
  if (platform === 'win32') return 'winget install --id Google.Chrome -e';
  return LINUX_CHROME_INSTALL;
}

/** Where this platform was searched: the operator's `CHROME_PATH` when set, else every candidate. */
export const browserSearched = (env: Env, platform: string): readonly string[] => {
  const declared = env[CHROME_PATH_ENV];
  return declared !== undefined && declared !== ''
    ? [`${CHROME_PATH_ENV}=${declared}`]
    : chromeCandidates(platform, env);
};

/**
 * Install first, because it is the command that clears the finding on a bare machine; naming a
 * binary that is already there is the alternative, behind the `#`, as is proving it took.
 */
export const e2eBrowserMissingFinding = (env: Env, platform: string): Finding => ({
  code: E2E_BROWSER_MISSING,
  cause: `${VERIFY_FLOOR_FILE} requires the e2e step and no Chrome or Chromium was found (searched ${browserSearched(env, platform).join(', ')}), so every browser-backed e2e test skipped`,
  fix: `${browserInstallCommand(platform)}   # or export ${CHROME_PATH_ENV}=<any Chrome, Chromium or Edge binary>; then x doctor --json names the browser it found`,
  docs: ERROR_DOCS_URL,
  at: VERIFY_FLOOR_FILE,
});

/**
 * The e2e step's outcome, judged for the one case the floor alone words wrong: an APP that
 * requires `e2e`, whose suite ran nothing, on a machine with no browser. `X_VERIFY_SUITE_VANISHED`
 * still follows (`verify-run.ts` reads the same counts) but its fix reruns the suite, which skips
 * again; this finding goes first because its fix is the one that changes the answer. Asked after
 * the run, never before: a floored suite whose tests need no browser keeps passing.
 */
export async function judgeE2eBrowser(input: {
  readonly root: string;
  readonly isApp: boolean;
  readonly outcome: StepOutcome;
  readonly env: Env;
  readonly platform?: string;
}): Promise<StepOutcome> {
  const { outcome } = input;
  if (!input.isApp || outcome.tests === undefined || outcome.tests.ran > 0) return outcome;
  if (!floorRequires(await readVerifyFloor(input.root), 'e2e')) return outcome;
  const platform = input.platform ?? process.platform;
  if ((await findChrome(input.env, platform)) !== undefined) return outcome;
  return {
    ...outcome,
    ok: false,
    findings: [e2eBrowserMissingFinding(input.env, platform), ...outcome.findings],
  };
}
