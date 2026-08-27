// One responsibility: start a Chrome in this container and hand back its DevTools endpoint and the
// way to stop it. The connection is `cdp-connection.ts` and the page surface `cdp-e2e-page.ts`.

// why: Bun exposes no recursive-remove and no temp-root primitive, so the throwaway profile
// directory this launcher must create and delete needs both.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { CdpBrowserMissingError, CdpLaunchFailedError } from './cdp-errors';

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
 * The flags, and every one of them earns its line.
 *
 * `--headless=new` is Chrome's own headless rather than the retired shim. `--remote-debugging-port=0`
 * asks the OS for a free port, so two suites on one machine never collide — the port is read back
 * off stderr, which is the only place Chrome states the one it took. A throwaway `--user-data-dir`
 * because a run sharing a profile with a real browser inherits its cookies and locks its files.
 * `--no-sandbox` and `--disable-dev-shm-usage` are the two a container needs: the sandbox needs
 * privileges CI does not grant, and `/dev/shm` is 64 MB in a default container, which crashes the
 * renderer on any real page.
 */
const flags = (profileDir: string): readonly string[] => [
  '--headless=new',
  '--remote-debugging-port=0',
  `--user-data-dir=${profileDir}`,
  '--no-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  // Nothing here should reach the network on its own account, and a first-run bubble or an update
  // check is a page load the test did not ask for.
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  'about:blank',
];

const ENDPOINT = /DevTools listening on (ws:\/\/\S+)/;

export interface LaunchedBrowser {
  readonly endpoint: string;
  /** Idempotent: killing a dead process and deleting a gone directory are both no-ops. */
  close(): void;
}

export interface LaunchOptions {
  readonly executable: string;
  /** How long Chrome has to announce its endpoint before this gives up and kills it. */
  readonly timeoutMs: number;
}

/**
 * Chrome announces `DevTools listening on ws://…` on **stderr**, once, before it is usable. Reading
 * it there rather than polling `/json/version` is what makes `--remote-debugging-port=0` safe: with
 * a random port there is no URL to poll until Chrome has said which one it took.
 */
export async function launchChrome(options: LaunchOptions): Promise<LaunchedBrowser> {
  const profileDir = mkdtempSync(join(tmpdir(), 'x-e2e-chrome-'));
  const child = Bun.spawn([options.executable, ...flags(profileDir)], {
    stderr: 'pipe',
    stdout: 'ignore',
  });
  const close = (): void => {
    child.kill();
    rmSync(profileDir, { recursive: true, force: true });
  };

  const reader = (child.stderr as ReadableStream<Uint8Array>).getReader();
  const decoder = new TextDecoder();
  let seen = '';
  const deadline = Bun.nanoseconds() + options.timeoutMs * 1_000_000;
  try {
    while (Bun.nanoseconds() < deadline) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += decoder.decode(value, { stream: true });
      const found = ENDPOINT.exec(seen);
      if (found?.[1] !== undefined) return { endpoint: found[1], close };
    }
  } finally {
    reader.releaseLock();
  }
  close();
  // Chrome's own stderr is the actionable half — a missing library, a sandbox refusal, a bad flag
  // are all named there — so it is reported rather than "the launch failed".
  throw new CdpLaunchFailedError({
    executable: options.executable,
    detail:
      seen.trim() === ''
        ? 'it printed nothing before the deadline'
        : seen.trim().split('\n').slice(-3).join(' | '),
  });
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
