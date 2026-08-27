// The vocabulary a `run()` body writes against — small, declarative, and driver-blind. Every verb
// is here because every scraper in the audit re-implemented it and nothing else; a new one is a
// second way to do something already on this list. NO COUNT: this said "Fourteen verbs" against
// twenty-three, and a prose ordinal is wrong the moment the next verb lands.
//
// Nothing here mentions puppeteer, CDP, a frame handle or a locator. That is the seam: a run body
// written against this file runs unchanged on a real browser, on a recorded fixture and on a
// parsed HTML string, which is what makes `bun test` need no Chrome.

import type { Secret } from '@ultimat3/core';
import type { ActionabilityState } from './actionability';
import type { CaptureFraming } from './capture-clip';
import type { ColorScheme } from './color-scheme';
import type { ConsoleLine, NetworkEntry, PageError } from './rings';
import type { SessionSnapshot } from './session-state';
import type { ElementSnapshot, ScrapeCookie, ScrapeDownloadFile } from './target';

export interface WaitOptions {
  readonly state?: ActionabilityState | undefined;
  /** Milliseconds. Falls back to the scrape's own `timeout`. */
  readonly timeout?: number | undefined;
}

export interface ElementValue {
  readonly tag: string;
  readonly text: string;
  /** The control's value, `''` for anything that is not one. */
  readonly value: string;
  readonly attrs: Readonly<Record<string, string>>;
}

/**
 * A frame, or the document — everything both can do. Held as a LAZY handle: every method
 * re-resolves its underlying frame at call time, so a handle taken before a navigation still
 * addresses the right frame afterwards rather than a detached one.
 */
export interface ScrapeFrame {
  url(): string;
  /** Blocks until the element reaches `state` (default `actionable`), then answers its snapshot. */
  waitFor(selector: string, options?: WaitOptions): Promise<ElementSnapshot>;
  /**
   * Waits for the element to be visible, enabled, unobstructed and STILL before clicking. A raw
   * driver's click waits for the selector alone, which is why every app that uses one grows a
   * `waitForTimeout(800)` somewhere above it.
   */
  click(selector: string, options?: WaitOptions): Promise<void>;
  /** Appends. A `Secret` marks this page as carrying one, which refuses later pixel captures. */
  type(selector: string, text: string | Secret, options?: WaitOptions): Promise<void>;
  /** Clears first, then types — the spelling a login form wants. */
  fill(selector: string, text: string | Secret, options?: WaitOptions): Promise<void>;
  select(selector: string, values: readonly string[], options?: WaitOptions): Promise<void>;
  /**
   * Every match, as SNAPSHOTS — `visible`, `enabled` and (on a driver with a layout engine) the
   * box and hit-target, which `values()` projects away.
   *
   * It exists because `ScrapeTarget.query` already answered all of that and nothing above it
   * exposed it, so the first caller that needed "is this visible?" wrote its own
   * `display !== 'none' && visibility !== 'hidden' && opacity !== '0'` — a second definition of
   * "visible" in one framework. `values()` remains the projection for row assembly; this is the
   * read for a decision about an element.
   */
  query(selector: string): Promise<readonly ElementSnapshot[]>;
  /** Every match, as values. Row assembly is the app's business, never the framework's. */
  values(selector: string): Promise<readonly ElementValue[]>;
  /** The first match's text, or `''`. */
  text(selector?: string): Promise<string>;
  /** Serialised HTML, redacted by value and with password fields blanked. */
  html(): Promise<string>;
  count(selector: string): Promise<number>;
  /** The expression's result, `unknown` — parse it with a schema, never cast it. */
  evaluate(expression: string): Promise<unknown>;
  /**
   * A child frame by name, `id`, or `<iframe>` selector. RE-RESOLVED on every call made through
   * the returned handle: a frame handle captured before a re-navigation is the single biggest
   * correctness trap in this whole vocabulary, and the type cannot express "stale" — so nothing
   * here holds one.
   */
  frame(nameOrSelector: string): ScrapeFrame;
}

/**
 * `fullPage`, or a `clip` — never both. `timeout` is gone with the port's; see `CaptureOptions`.
 *
 * A clip is what makes a capture reviewable by a vision model: the whole viewport spends the
 * reader's scarce pixels on everything that is not the component under review.
 */
export type CaptureRequest = CaptureFraming;

export interface DownloadRequest {
  readonly timeout?: number | undefined;
}

export interface ScrapePage extends ScrapeFrame {
  /**
   * Navigate. Refused before a byte leaves when the host is not in `allowHosts`
   * (`X_SCRAPE_HOST_BLOCKED`) or robots.txt disallows the path (`X_SCRAPE_ROBOTS_DISALLOWED`).
   */
  goto(url: string, options?: { readonly timeout?: number | undefined }): Promise<void>;
  /** PNG bytes. REFUSED once a secret has been typed into this page — see `secrets.ts`. */
  screenshot(options?: CaptureRequest): Promise<Uint8Array>;
  /** PDF bytes. Refused on the same condition, for the same reason. */
  pdf(options?: CaptureRequest): Promise<Uint8Array>;
  /** The file the last click produced, or `X_SCRAPE_DOWNLOAD_TIMEOUT`. */
  download(options?: DownloadRequest): Promise<ScrapeDownloadFile>;
  cookies(): Promise<readonly ScrapeCookie[]>;
  /**
   * Cut the BROWSER's network, or restore it — what a PWA's offline behaviour has to be tested
   * against. Refused with `X_NOT_IMPLEMENTED` on a driver that has no browser: patching `fetch`
   * in the test process cannot reach a browser's own requests, so a driver that quietly answered
   * "done" would let an offline assertion pass against an app that never went offline.
   */
  offline(enabled: boolean): Promise<void>;
  /**
   * Tell the browser what the user's OS colour preference is, so a component that resolves its own
   * theme resolves to this one. `'no-preference'` CLEARS the override and gives the browser's own
   * answer back — it is not a third value a stylesheet can match.
   *
   * The INPUT, never the outcome: an attribute on the document is the outcome of a theme decision
   * and the component owns that — one honouring `'system'` overwrites or deletes it on mount, and
   * the picture then shows the theme the component chose rather than the one that was asked for.
   *
   * ACCEPTED on every driver, unlike `offline()`: the offline drivers evaluate no CSS, but they
   * answer different deterministic bytes per scheme, so the one thing a preference could be wrong
   * about is still under test. `X_NOT_IMPLEMENTED` is reserved for a LAUNCHER that lacks the
   * method, which is a fact about the build rather than about the driver.
   */
  colorScheme(scheme: ColorScheme): Promise<void>;
  /**
   * The handoff, made explicit: what the HTTP leg will send, as a value an author can inspect and
   * a fixture can assert on. `http` uses it automatically — this is for seeing what carried over.
   */
  session(): Promise<SessionSnapshot>;
  /** The bounded tail. Bounded because a long run's full history is an OOM, not a log. */
  console(): readonly ConsoleLine[];
  /**
   * The uncaught exceptions the page threw, which `console()` does NOT carry: an island that
   * throws calls no console method, so a scrape reading console alone sees a page that looks
   * silent and is broken. Empty on a driver with no JS engine — the offline drivers parse HTML
   * and never execute it, so nothing there can throw.
   */
  pageErrors(): readonly PageError[];
  network(): readonly NetworkEntry[];
  /**
   * How many entries the bound above threw away. It is the same honesty `Ring.dropped` carries:
   * any count taken from `network()` — the run's `refused` total included — is a floor once this
   * is non-zero, and a scrape that blocked 5,000 images otherwise reports 200 with no hint.
   */
  networkDropped(): number;
  /**
   * The same honesty for the errors, and it is the count a verdict gates on: an island throwing
   * inside a `requestAnimationFrame` produces thousands, and "3 page errors" read off a bounded
   * tail of 200 would be a number a reader trusts and should not.
   */
  pageErrorsDropped(): number;
}
