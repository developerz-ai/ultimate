// One constructor per failure mode, so a throw site is one call and every `cause`/`fix` pair for
// a code is written once. Nothing here interpolates an `unknown` into a cause: an exception from
// a browser is rendered through core's `renderThrowable`, which is the rule `bun run error-render`
// enforces.

import { renderThrowable, UltimateError } from '@ultimat3/core';
import { ScrapeError } from './errors';

export const driverUnknown = (name: string, installed: readonly string[]): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_DRIVER_UNKNOWN',
    cause: `no scrape driver named "${name}" is installed; installed: ${installed.join(', ') || 'none'}`,
    fix: 'call setScrapeDriver(localBrowser()) at boot, or pass driver: fakeBrowser() on the scrape() definition',
    meta: { driver: name },
  });

export const cdpAttachFailed = (cdpUrl: string, thrown: unknown): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_CDP_ATTACH_FAILED',
    cause: `the CDP endpoint ${cdpUrl} refused the attach: ${renderThrowable(thrown)}`,
    fix: 'curl "$CDP_URL/json/version" to confirm the endpoint answers, then pass that webSocketDebuggerUrl to remoteBrowser({ cdpUrl })',
    meta: { cdpUrl },
  });

export const browserUnreachable = (driver: string, thrown: unknown): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_BROWSER_UNREACHABLE',
    cause: `the ${driver} browser stopped answering: ${renderThrowable(thrown)}`,
    fix: 'raise watchdog: { idleMs } on the scrape() definition if the site is genuinely slow, otherwise re-run once the browser host is back',
    meta: { driver },
  });

export const profileLocked = (profileDir: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PROFILE_LOCKED',
    cause: `another browser process holds the profile at ${profileDir}`,
    fix: `rm -f ${profileDir}/SingletonLock once no browser is using it, or give this run its own localBrowser({ profileDir })`,
    meta: { profileDir },
  });

export const hostBlocked = (url: string, allowed: readonly string[]): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_HOST_BLOCKED',
    cause: `the page requested ${url}, and allowHosts lists ${allowed.join(', ') || 'nothing'}`,
    fix: `add the host to allowHosts on the scrape() definition — allowHosts: [${allowed.map((host) => `'${host}'`).join(', ')}, '<the host above>']`,
    meta: { url, allowed },
  });

export const selectorMissing = (selector: string, url: string, waitedMs: number): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_SELECTOR_MISSING',
    cause: `"${selector}" never appeared on ${url} within ${String(waitedMs)}ms`,
    fix: "open the run's page.html artifact and re-derive the selector, or raise the timeout on this waitFor({ timeout })",
    meta: { selector, url, waitedMs },
  });

export const notActionable = (selector: string, reason: string, waitedMs: number): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_NOT_ACTIONABLE',
    cause: `"${selector}" is present and ${reason} after ${String(waitedMs)}ms`,
    fix: 'wait for the state that unblocks it — page.waitFor(selector, { state: "enabled" }) — or dismiss whatever overlays it before the click',
    meta: { selector, reason, waitedMs },
  });

export const scrapeTimeout = (what: string, ms: number): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_TIMEOUT',
    cause: `${what} exceeded its ${String(ms)}ms budget`,
    fix: 'raise timeout: on the scrape() definition, or split the pass so each step.run stays inside one budget',
    meta: { what, ms },
  });

export const wedged = (what: string, idleMs: number): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_WEDGED',
    cause: `${what} produced no browser activity for ${String(idleMs)}ms, so the process was killed`,
    fix: 'raise watchdog: { idleMs } on the scrape() definition if the site is genuinely this slow, otherwise re-run — the browser was killed and its session is gone',
    meta: { what, idleMs },
  });

export const pageCrashed = (url: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PAGE_CRASHED',
    cause: `the renderer for ${url} died mid-run, so this attempt's page state is gone`,
    fix: 'lower concurrency: on the scrape() definition or raise the container memory limit in docker-compose.prod.yml — a crashed renderer is out of memory far more often than it is a bug',
    meta: { url },
  });

export const outputInvalid = (name: string, detail: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_OUTPUT_INVALID',
    cause: `scrape "${name}" produced rows its extract schema rejects: ${detail}`,
    fix: "align the extract schema with the page — the run's page.html artifact holds the markup the rows came from",
    meta: { scrape: name },
  });

export const downloadTimeout = (ms: number, url: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_DOWNLOAD_TIMEOUT',
    cause: `no download landed within ${String(ms)}ms of the trigger on ${url}`,
    fix: 'raise the timeout on page.download({ timeout }), or confirm the trigger is the element that starts the download',
    meta: { ms, url },
  });

/**
 * The silent-green alarm. A scraper that succeeds and returns nothing stays green for weeks, and
 * every field of this cause is there so the first read answers "was it always this low, or did it
 * fall off a cliff today?" without opening a dashboard.
 */
export const yieldCollapsed = (input: {
  readonly scrape: string;
  readonly rows: number;
  readonly reason: 'min-rows' | 'drop';
  readonly minRows?: number | undefined;
  readonly baseline?: number | undefined;
  readonly maxDrop?: number | undefined;
}): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_YIELD_COLLAPSED',
    cause:
      input.reason === 'min-rows'
        ? `scrape "${input.scrape}" returned ${String(input.rows)} rows and declares expect.minRows ${String(input.minRows)}`
        : `scrape "${input.scrape}" returned ${String(input.rows)} rows against a trailing median of ${String(input.baseline)}, past the ${String(Math.round((input.maxDrop ?? 0) * 100))}% drop expect.maxDrop allows`,
    fix: "open the run's page.html artifact and compare it with the extract selectors — a collapse is the page changing far more often than the data changing",
    meta: {
      scrape: input.scrape,
      rows: input.rows,
      reason: input.reason,
      minRows: input.minRows,
      baseline: input.baseline,
      maxDrop: input.maxDrop,
    },
  });

export const robotsDisallowed = (url: string, agent: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_ROBOTS_DISALLOWED',
    cause: `robots.txt disallows ${url} for user-agent "${agent}"`,
    fix: "declare robots: { ignore: '<the written reason this run is permitted>' } on the scrape() definition, or scrape a path robots.txt allows",
    meta: { url, agent },
  });

export const fixtureMissing = (url: string, dir: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_FIXTURE_MISSING',
    cause: `the fixture driver has no recording of ${url} under ${dir}, and an offline driver never reaches the network`,
    fix: `add ${dir}/<the recording file> with { "url": "${url}", "html": "…" }, or point fixtureBrowser() at the directory that already holds it`,
    meta: { url, dir },
  });

export const fixtureStale = (url: string, ageMs: number, maxAgeMs: number): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_FIXTURE_STALE',
    cause: `the recording of ${url} is ${String(Math.round(ageMs / 86_400_000))} days old and fixtureBrowser declares maxAge ${String(Math.round(maxAgeMs / 86_400_000))} days`,
    fix: 're-record the fixture directory, or raise maxAge on fixtureBrowser({ maxAge }) with the reason an old recording still proves something',
    meta: { url, ageMs, maxAgeMs },
  });

export const remoteRequired = (driver: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_REMOTE_REQUIRED',
    cause: `the ${driver} driver attaches to a browser somebody else started and was given no cdpUrl`,
    fix: 'pass remoteBrowser({ cdpUrl: env.SCRAPE_CDP_URL }), or use localBrowser({ launcher }) to start one in this container',
    meta: { driver },
  });

export const recoverRefused = (name: string, reason: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_RECOVER_REFUSED',
    cause: `the recover hook on scrape "${name}" declined this failure: ${reason}`,
    fix: "widen recover() to handle this failure, or drop recover: and let the job's retry policy own it",
    meta: { scrape: name, reason },
  });

export const secretExposed = (artifact: string, url: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_SECRET_EXPOSED',
    cause: `a ${artifact} of ${url} was requested after a secret was typed into this page, and pixels cannot be redacted afterwards`,
    fix: 'call artifact.html() instead — page HTML is redacted by value and password fields are blanked — or take the capture before the secret is typed',
    meta: { artifact, url },
  });

/** A non-2xx from the HTTP leg. 4xx below 429 is terminal; everything else may be tried again. */
export const httpFailed = (url: string, status: number, body: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_HTTP_FAILED',
    cause: `${url} answered ${String(status)}: ${body}`,
    fix: 'confirm the endpoint the browser leg calls is the one this request names — page.network() lists every URL the page actually fetched',
    meta: { url, status },
    retry: status >= 400 && status < 500 && status !== 429 ? 'terminal' : 'retryable',
  });

/**
 * TERMINAL, and the retry table cannot be talked out of it. A site that locks an account after
 * three wrong attempts turns a retrying framework into the thing that destroys the user's
 * account, so this failure ends the run — no backoff, no recovery hook, no second attempt.
 */
export const authFailed = (scrape: string, detail: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_AUTH_FAILED',
    cause: `scrape "${scrape}" was refused by the site's login: ${detail}`,
    fix: 'correct the credential in .env.local for the name listed in secrets: on the scrape() definition — this run will NOT be retried, deliberately: a second wrong attempt is how an account gets locked',
    meta: { scrape },
  });

export const sessionExpired = (scrape: string, key: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_SESSION_EXPIRED',
    cause: `the stored session ${key} for scrape "${scrape}" failed its validate() probe and the definition declares no auth.login`,
    fix: `add auth: { login } to scrape("${scrape}") so an expired session can be replaced, or drop auth.validate and let the body handle the logged-out page`,
    meta: { scrape, key },
  });

export const promptUnanswered = (scrape: string, label: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_PROMPT_UNANSWERED',
    cause: `scrape "${scrape}" asked for "${label}" and no prompt handler was declared`,
    fix: `add prompt: async ({ label }) => await otpFor(label) to scrape("${scrape}") — a code that arrives out of band needs somewhere to come from`,
    meta: { scrape, label },
  });

/**
 * The identity is spent. Retryable — and the run BURNS the session before the retry, because a
 * flagged profile stays flagged and reloading it re-trips the same block every time.
 */
export const blocked = (scrape: string, url: string, detail: string): ScrapeError =>
  new ScrapeError({
    code: 'X_SCRAPE_BLOCKED',
    cause: `scrape "${scrape}" was refused by ${url}: ${detail}`,
    fix: 'the session is burned and the next attempt starts a new identity — lower rate: on the scrape() definition if this repeats',
    meta: { scrape, url },
  });

/**
 * The honest stub, in the shape `packages/jobs/src/driver-redis.ts` uses: correct types so an app
 * can be written against the seam, and one labelled throw so nobody discovers the gap from a
 * silently-skipped recovery.
 */
export const scrapeNotImplemented = (feature: string, fix: string): UltimateError =>
  new UltimateError({
    code: 'X_NOT_IMPLEMENTED',
    cause: `${feature} is declared and not implemented in @ultimat3/scraping`,
    fix,
    meta: { feature },
  });
