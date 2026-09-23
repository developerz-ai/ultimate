// One responsibility: start a Chrome in this container and hand back its DevTools endpoint and the
// way to stop it. The connection is `cdp-connection.ts` and the page surface `cdp-e2e-page.ts`.

// why: Bun exposes no recursive-remove and no temp-root primitive, so the throwaway profile
// directory this launcher must create and delete needs both.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { CdpConnection } from './cdp-connection';
import { cdpConnectOver } from './cdp-connection';
import { CdpBrowserMissingError, CdpLaunchFailedError } from './cdp-errors';
import { pipeTransport } from './cdp-pipe';

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
 * Exported so `browser-launcher.ts`'s `appBrowser` — a DIFFERENT launch path, `puppeteer-core`'s
 * own `launch()` rather than the `Bun.spawn` below — passes the SAME two, rather than a second
 * list that agrees today and drifts the next time either changes. `x shot` had neither before this
 * export existed, so a box where `x verify`'s e2e gate ran green could not run `x shot` at all.
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
  // no secret worth a keyring. `puppeteer-core` passes both by default, so `x shot` never had this.
  '--password-store=basic',
  '--use-mock-keychain',
  // Nothing here should reach the network on its own account, and a first-run bubble or an update
  // check is a page load the test did not ask for.
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions',
  'about:blank',
];

export interface LaunchedBrowser {
  /** The browser's own CDP connection, over its debugging pipe. Already answering. */
  readonly connection: CdpConnection;
  /** Idempotent: closes the connection, kills the process, deletes the profile. */
  close(): void;
}

export interface LaunchOptions {
  readonly executable: string;
  /** How long Chrome has to answer its first call, and every call's deadline after that. */
  readonly timeoutMs: number;
}

const STDERR_TAIL_CHARS = 4_000;

/**
 * Read stderr to its end for the life of the process, keeping only a bounded tail. A pipe nobody
 * reads fills, and Chrome's next stderr write then blocks the thread making it — a browser that
 * stops answering mid-run for a reason no log shows. The tail is the launch-failure diagnostics:
 * a missing library, a sandbox refusal and a bad flag are all named there and nowhere else.
 */
function stderrTail(stream: ReadableStream<Uint8Array>): {
  readonly text: () => string;
  /** Settles once the stream has ended — every byte the process wrote has been read. */
  readonly drained: Promise<void>;
} {
  let text = '';
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of stream) {
      text = (text + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
    }
  })().catch(() => undefined);
  return { text: () => text, drained };
}

/**
 * How long a browser that failed its first call gets to finish dying, and its stderr to finish
 * draining, before the tail is read. The pipe ending and the stderr reader reaching the last line
 * are two unordered events; read at the first, the reason a browser died was reported as "printed
 * nothing". Bounded, because a WEDGED browser neither exits nor closes stderr.
 */
const FAILURE_DRAIN_MS = 1_000;

const within = (ms: number, work: Promise<unknown>): Promise<unknown> =>
  Promise.race([work, Bun.sleep(ms)]);

/**
 * Start Chrome on a throwaway profile and answer once it has answered one CDP call. With a pipe
 * there is no "DevTools listening" line to wait for — the first reply IS the readiness signal, and
 * a browser that dies or stays silent before it is `X_CDP_LAUNCH_FAILED` carrying its own stderr.
 */
export async function launchChrome(options: LaunchOptions): Promise<LaunchedBrowser> {
  const profileDir = mkdtempSync(join(tmpdir(), 'x-e2e-chrome-'));
  const child = Bun.spawn([options.executable, ...chromeLaunchFlags(profileDir)], {
    // Chrome's fd 3 is where it READS commands and fd 4 where it WRITES replies and events.
    stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'],
  });
  const tail = stderrTail(child.stderr as ReadableStream<Uint8Array>);
  const [, , , toBrowser, fromBrowser] = child.stdio as unknown as readonly number[];
  const sink = Bun.file(toBrowser ?? -1).writer();
  const connection = cdpConnectOver(
    pipeTransport({
      write: (bytes) => {
        sink.write(bytes);
        void sink.flush();
      },
      read: Bun.file(fromBrowser ?? -1).stream(),
      end: () => {
        void Promise.resolve(sink.end()).catch(() => undefined);
      },
    }),
    options.timeoutMs,
  );
  let closed = false;
  const close = (): void => {
    if (closed) return;
    closed = true;
    connection.close();
    child.kill();
    rmSync(profileDir, { recursive: true, force: true });
  };
  try {
    await connection.send('Browser.getVersion');
    return { connection, close };
  } catch {
    await within(FAILURE_DRAIN_MS, child.exited);
    close();
    await within(FAILURE_DRAIN_MS, tail.drained);
    const seen = tail.text().trim();
    throw new CdpLaunchFailedError({
      executable: options.executable,
      detail:
        seen === ''
          ? 'it answered no DevTools call and printed nothing before the deadline'
          : seen.split('\n').slice(-3).join(' | '),
    });
  }
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
