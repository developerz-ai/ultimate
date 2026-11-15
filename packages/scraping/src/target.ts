// The driver-blind currency: what every browser driver hands back, and the only shape the page
// vocabulary reads. No puppeteer type, no CDP type and no `any` crosses this line — which is what
// lets `page-over-target.ts` be the ONE implementation of `ScrapePage` for the real browser, the
// fixture replayer and the fake alike.

import type { CaptureFraming } from './capture-clip';
import type { ColorScheme } from './color-scheme';
import type { PdfLayout } from './pdf-request';
import type { ConsoleRing, NetworkRing, PageErrorRing } from './rings';
import type { SessionSnapshot } from './session-state';

/**
 * The document root, as a selector every target must answer. `text()` with no argument is "all
 * the text on this page", and a driver-specific spelling of that would be the first thing to
 * diverge between the fake and the real browser.
 */
export const ROOT_SELECTOR = 'html';

/** What a `query()` may do to the page before it measures. */
export interface QueryOptions {
  /**
   * Scroll the FIRST match into the viewport before measuring. `elementFromPoint` answers nothing
   * for a point off-screen, so without it every element below the fold read `hitTarget: false` —
   * "covered" — and each act on it waited out its whole timeout as `X_SCRAPE_NOT_ACTIONABLE`.
   * Only the `actionable` wait asks (`page-over-target.ts`): a READ must not move the page, or the
   * next screenshot is of somewhere else. A driver with no layout engine ignores it.
   */
  readonly reveal?: boolean | undefined;
}

export interface ElementBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * One element, as of one observation. Everything the actionability rule needs, and nothing that
 * would let a caller hold a live handle: a snapshot is a VALUE, so it cannot go stale behind the
 * caller's back the way a `frameLocator` handle does — it is simply old, and `page-over-target.ts`
 * takes a fresh one before every act.
 */
export interface ElementSnapshot {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  /** The form value for a control, `''` for anything else. Never `undefined` — absent is ''. */
  readonly value: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  /**
   * Absent means THIS TARGET HAS NO LAYOUT ENGINE (the fake and the fixture parse HTML; nothing
   * is laid out). Never a fabricated zero box: `driver-parity.test.ts` pins the divergence in one
   * place, and a `{ x: 0, y: 0 }` invented here would make a covered button test green on the
   * only driver that could have caught it.
   */
  readonly box?: ElementBox | undefined;
  /** Whether this element is what a click at its own centre would hit. Absent: no layout. */
  readonly hitTarget?: boolean | undefined;
}

/**
 * One node of the browser's accessibility tree, as of one observation — what a screen reader is
 * told about an element, which is a different fact from what `ElementSnapshot` says about its
 * markup. `role` and `name` are always answered, `''` when the browser computed nothing: absent is
 * a real answer for a `<div>`, and a fabricated `generic` would hide the elements a reader cannot
 * name. A VALUE, like `ElementSnapshot`: it cannot go stale behind the caller's back, only old.
 */
export interface AxNode {
  readonly role: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly value?: string | undefined;
  readonly focused?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  /** Pruned from the tree a reader walks — `aria-hidden`, or a wrapper with nothing to say. */
  readonly ignored: boolean;
}

export interface ScrapeCookie {
  readonly name: string;
  readonly value: string;
  readonly domain: string;
  readonly path: string;
  readonly expires?: number | undefined;
  readonly httpOnly: boolean;
  readonly secure: boolean;
}

export interface ScrapeDownloadFile {
  readonly filename: string;
  readonly bytes: Uint8Array;
}

/** A child frame, addressed by whatever the page can see of it. */
export interface FrameRef {
  readonly name: string;
  readonly url: string;
  /** The `<iframe>` selector in the PARENT document, when the driver can tell. */
  readonly selector?: string | undefined;
  /** The FRAME's verbs only: a page-wide verb on it does not compile, never the parent's answer. */
  readonly target: ScrapeFrameTarget;
}

export interface GotoOptions {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
}

/**
 * `CaptureFraming`, under the port's own name: `fullPage` for the whole document, or a `clip` to
 * crop to one rectangle, never both. ONE declaration for the port and the vocabulary — the two
 * were separate copies of `{ fullPage }` and a field added to one would have reached neither the
 * drivers nor the callers.
 *
 * It carried a required `timeoutMs` until 2026-08 that NO driver
 * honoured — `cdp-target.ts` read only `fullPage`, `html-target.ts` ignored the whole object —
 * so `page.screenshot({ timeout })` was a documented deadline that bounded nothing. Deleted
 * rather than implemented: the CDP port's own `screenshot({ fullPage })` has no timeout slot to
 * forward it to, and a deadline enforced in `page-over-target.ts` would have to race
 * `SleepClock.sleep`, which under `frozenClock` resolves on the first microtask and would time
 * out every capture in every test. A driver's own default is the honest bound.
 */
export type CaptureOptions = CaptureFraming;

/**
 * A PDF capture: the framing plus the print layout, already checked by `pdfLayoutOf` — a driver
 * forwards every field it is given and invents none.
 */
export type PdfOptions = CaptureOptions & PdfLayout;

/**
 * The verbs a FRAME's own document answers — the half of the port a frame target implements. A
 * frame target used to be the whole `ScrapeTarget`, built by spreading the parent's, so every
 * page-wide verb nobody overrode (a capture, the cookie jar, the accessibility read) answered for
 * the PARENT document through a frame handle, or was refused there at runtime. Narrowed instead:
 * `FrameRef.target` is this type, and asking a frame for a page-wide verb does not compile.
 */
export interface ScrapeFrameTarget {
  url(): string;
  /** Serialised HTML of THIS target — the document for a page, the subtree for a frame. */
  content(): Promise<string>;
  query(selector: string, options?: QueryOptions): Promise<readonly ElementSnapshot[]>;
  /**
   * Clicks the FIRST match. It took an `index` until 2026-08 that `html-target.ts` honoured and
   * `cdp-target.ts` dropped — its implementations are `click: (selector) => …`, so puppeteer
   * clicked match 0 whatever was asked. They agreed only because `page-over-target.ts`, the sole
   * caller, always passed `0`, and no public vocabulary could set it: `ScrapeFrame.click` takes
   * `(selector, options?: WaitOptions)`. A port member no app can reach and one driver ignores is
   * a divergence waiting to be found by an app, so it is gone. `driver-parity.test.ts` pins that
   * all three drivers click the first match.
   */
  click(selector: string): Promise<void>;
  /** Appends, exactly as typing does. Clearing first is `fill`'s job at the page level. */
  type(selector: string, text: string): Promise<void>;
  clear(selector: string): Promise<void>;
  select(selector: string, values: readonly string[]): Promise<void>;
  /** The expression runs in the page. The result is `unknown` and is parsed by the caller. */
  evaluate(expression: string): Promise<unknown>;
  /**
   * A key chord — `'Meta+K'`, `'Escape'`, `'Shift+Tab'` — pressed on whatever holds focus. The
   * PAGE's keyboard, on a frame target too: a browser has one keyboard, and the focused element
   * is what decides which document hears it. REQUIRED, and `CdpPageLike.keyboard` is required
   * too: a launcher without one does not compile. A driver with no keyboard still PARSES the
   * chord (`key-chord.ts`) and then resolves — the refusal an offline driver can give is the one
   * it does give.
   */
  press(chord: string): Promise<void>;
  /** Moves focus to the first match. Refused when nothing matches. */
  focus(selector: string): Promise<void>;
  frames(): Promise<readonly FrameRef[]>;
}

/**
 * The port. Every member is something a browser genuinely does and nothing a scraper's vocabulary
 * should be re-deriving per driver. NO COUNT: this comment said "Twelve methods" while the
 * interface carried seventeen, and a number in prose is wrong the moment the next member lands.
 * `ScrapeTarget` itself is the list — the frame verbs it extends, then the page-wide ones.
 *
 * No member here is refused by any target in this package (`port-complete.test.ts` calls every one
 * on every driver): a member one target cannot honour is a second path, and the answer to it is
 * implementing it there or narrowing the type, never `X_NOT_IMPLEMENTED` at runtime.
 */
export interface ScrapeTarget extends ScrapeFrameTarget {
  /** `puppeteer` | `fixture` | `fake`. Appears in every error cause raised against it. */
  readonly driver: string;
  readonly console: ConsoleRing;
  readonly network: NetworkRing;
  /**
   * REQUIRED, and empty is a legitimate answer. A driver with no JS engine has no uncaught
   * exception to report and answers an empty ring; an optional member would instead let a driver
   * be silent about errors it CAN see, which is precisely the blind spot this ring closes — and
   * `ScrapePage.pageErrors()` would then be a method that answers nothing on an unknown subset of
   * drivers. A third-party driver added before 2026-08-21 gets a type error naming this field,
   * which is the whole enforcement.
   */
  readonly pageErrors: PageErrorRing;
  goto(url: string, options: GotoOptions): Promise<void>;
  /**
   * The accessibility node of every match, bounded by `max` — what a screen reader is told. A
   * browser answers what it COMPUTED (`cdp-a11y.ts`); the offline drivers answer the HTML-AAM
   * mapping of the markup (`html-a11y.ts`) — ARIA, the element's implicit role, label association
   * — and never `role=` alone: a `<div onclick>` maps to no role and no name on both, which is
   * the finding. PAGE-WIDE, not a frame verb: the CDP read is addressed by the top document's node
   * ids, so a frame handle has no accessibility read to offer and does not compile asking for one.
   */
  accessibility(selector: string, max: number): Promise<readonly AxNode[]>;
  /**
   * The browser goes offline, or comes back. Never a resolved no-op, which would let an
   * offline-behaviour test go green against an app that was online the whole time: the browser
   * driver sets it on the browser, and the offline drivers cut their OWN network — every
   * navigation fails while it is set, exactly as a browser's does (`html-target.ts`). What they
   * cannot do is run the app's offline code, so an assertion on what that code renders fails
   * there rather than passing.
   */
  setOfflineMode(enabled: boolean): Promise<void>;
  /**
   * What the browser reports as the user's OS colour preference — the INPUT to a theme decision.
   * `'no-preference'` CLEARS the override rather than setting one (`color-scheme.ts`).
   *
   * The INPUT and never the outcome. Setting `data-theme` on the document models the outcome, and
   * the component owns that: one that resolves `'system'` itself overwrites or deletes the
   * attribute on mount, so a harness that set it is silently overruled and every theme converges
   * on one picture — measured, and byte-identical, in issue #338.
   *
   * REQUIRED, and `CdpPageLike.emulateMediaFeatures` is required too: a launcher without the
   * method does not compile, rather than refusing at the call.
   *
   * A DRIVER WITH NO CSS ENGINE ACCEPTS IT, which is the one place this parts company with
   * `setOfflineMode`, and the line between them is which side of a capture the verb is on. An
   * offline ASSERTION is reachable on a driver that answers content, so `setOfflineMode` cuts the
   * offline driver's own navigations. A colour preference has no such assertion: the only thing
   * it could be wrong about is a picture, and the offline
   * drivers answer different deterministic bytes per scheme — exactly as they do per `clip` —
   * so a driver that dropped the preference fails a test rather than passing every one.
   */
  setColorScheme(scheme: ColorScheme): Promise<void>;
  /**
   * A script every document this target navigates to runs BEFORE its own — the browser's
   * `evaluateOnNewDocument`. REQUIRED, and `CdpPageLike.evaluateOnNewDocument` is required too:
   * a launcher without the method does not compile.
   *
   * A DRIVER WITH NO JS ENGINE ACCEPTS IT, for `setColorScheme`'s reason: the offline drivers
   * execute nothing, so there is no document script for the expression to run ahead of and no
   * assertion a resolved promise could let through — a seeded `localStorage` key is the INPUT to a boot script this driver never runs. Refusing
   * would make `x shot` and every `ui.*` tool untestable on a machine with no Chrome, and the
   * outcome it would protect does not exist here. The call is still checked for a closed target.
   */
  prepare(expression: string): Promise<void>;
  screenshot(options: CaptureOptions): Promise<Uint8Array>;
  pdf(options: PdfOptions): Promise<Uint8Array>;
  cookies(): Promise<readonly ScrapeCookie[]>;
  /**
   * Whatever the last click/navigation produced as a file, or a `X_SCRAPE_DOWNLOAD_TIMEOUT`. The
   * browser driver takes the bytes off the WIRE (`cdp-download.ts`), never a download directory,
   * so it answers the same on a launched browser and on a remote one whose disk is not ours.
   */
  download(options: { readonly timeoutMs: number }): Promise<ScrapeDownloadFile>;
  /**
   * Everything that makes this client THIS client: cookies, storage, the headers the site now
   * expects, the user agent. It is the browser-to-HTTP handoff, and it is the thing a session
   * store persists — so it is credential material and is summarised, never logged.
   */
  session(): Promise<SessionSnapshot>;
  /** Put a previously captured session back, before the first navigation. */
  restore(session: SessionSnapshot): Promise<void>;
  close(): Promise<void>;
}
