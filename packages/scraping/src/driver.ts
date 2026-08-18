// The browser contract. Every driver implements exactly this, so a scrape's body never names one
// — the same shape `packages/jobs/src/driver.ts` gives the queue, for the same reason: swapping
// the browser is `setScrapeDriver(other)` and ZERO run-body change.
//
// Two methods. `open` hands back a session; `close` ends it. Everything else a scraper does goes
// through `ScrapePage`, which is driver-blind by construction.

import type { ScrapeClock } from './clock';
import type { ScrapeHttp } from './http';
import type { InterceptRules } from './intercept';
import type { ScrapePage } from './page';
import type { RobotsGate } from './robots';
import type { ScrapeSecrets } from './secrets';
import type { SessionSnapshot } from './session-state';

export interface SessionInit {
  /** The scrape's name — every error cause raised inside the session carries it. */
  readonly name: string;
  readonly rules: InterceptRules;
  readonly clock: ScrapeClock;
  /** Per-operation default, in ms. A `waitFor` with its own `timeout` overrides it. */
  readonly timeoutMs: number;
  readonly secrets?: ScrapeSecrets | undefined;
  readonly robots?: RobotsGate | undefined;
  /** The run's cancellation. A driver that ignores it leaves a browser behind on every kill. */
  readonly signal?: AbortSignal | undefined;
  /** A previously captured session, put back before the first navigation. */
  readonly restore?: SessionSnapshot | undefined;
  /** BOTH transports dial through it. A different exit IP mid-session is a different client. */
  readonly proxy?: string | undefined;
  /** Awaited before every navigation AND every HTTP request — one budget across both legs. */
  readonly pace?: ((signal?: AbortSignal) => Promise<void>) | undefined;
  /** Called on every operation on either transport. The wedge watchdog measures the gaps. */
  readonly onActivity?: (() => void) | undefined;
  /**
   * The wedge discipline, as the scrape declared it: kill the browser after `idleMs` of silence,
   * and give a graceful quit `graceMs` before killing it anyway. A driver with no OS process to
   * reach still honours the abort half.
   */
  readonly watchdog?: { readonly idleMs?: number; readonly graceMs?: number } | undefined;
}

export interface ScrapeSession {
  readonly driver: string;
  readonly page: ScrapePage;
  /**
   * The second transport, bound to the SAME session as the page: the browser's cookies, headers
   * and proxy, the same `allowHosts`, the same rate limit, the same cancellation. A driver hands
   * both back together because the two legs of a hybrid scrape are one client, and a session that
   * could hand out only one of them would leave the other to be hand-rolled per app.
   */
  readonly http: ScrapeHttp;
  /**
   * Ends the session — and for a remote driver that means BOTH halves: the local connection AND
   * the browser somebody else is billing for. A `close()` that only disconnects leaves a paid
   * session running until its provider times it out, which is the bill nobody attributes.
   *
   * Idempotent, and never throws: it runs in a `finally`, and a close that threw would replace
   * the run's real failure with a teardown failure.
   */
  close(): Promise<void>;
}

export interface ScrapeDriver {
  /** `puppeteer` | `fixture` | `fake`. Appears in every error cause raised against it. */
  readonly name: string;
  open(init: SessionInit): Promise<ScrapeSession>;
}

let ambient: ScrapeDriver | undefined;

/** Set once at boot from `app.config.ts`. A scrape's own `driver:` overrides it per definition. */
export function setScrapeDriver(driver: ScrapeDriver): void {
  ambient = driver;
}

export function scrapeDriver(): ScrapeDriver | undefined {
  return ambient;
}

/**
 * Test/CLI seam: forget the ambient driver. The counterpart to `resetJobDriver()` — a test that
 * installs a browser has to be able to put the process back, or every later file in the same bun
 * process runs against a driver it never asked for.
 */
export function resetScrapeDriver(): void {
  ambient = undefined;
}
