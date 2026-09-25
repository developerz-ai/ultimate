// The browser surface `x shot` and the dev MCP server's `ui.*` tools drive, declared here and
// nowhere else. `cdp-shot-driver.ts` implements it over raw CDP; a test hands in a fake. Every
// member is one a shot or a `ui.*` call reads. A member nothing reads is one the raw driver would
// have to build and nothing would test, and that is how a port rots.
import type { Clock } from '@ultimat3/core';

/** What the browser is told the OS prefers. `'no-preference'` CLEARS the override. */
export type ShotColorScheme = 'light' | 'dark' | 'no-preference';

/** CSS pixels, top-left origin: the space `getBoundingClientRect()` answers in. */
export interface CaptureClip {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** `fullPage`, or a `clip` — never both. */
export interface ShotCapture {
  readonly fullPage?: boolean | undefined;
  readonly clip?: CaptureClip | undefined;
}

export interface ConsoleLine {
  readonly level: 'log' | 'info' | 'warn' | 'error' | 'debug';
  readonly text: string;
  readonly at: number;
}

/** An uncaught exception the page threw. Not a `ConsoleLine`: a throw calls no console method. */
export interface PageError {
  readonly message: string;
  /** Absent when the exception carried no stack, never `''`. */
  readonly stack?: string | undefined;
  readonly at: number;
}

export type ShotResourceType =
  | 'document'
  | 'stylesheet'
  | 'image'
  | 'media'
  | 'font'
  | 'script'
  | 'xhr'
  | 'fetch'
  | 'websocket'
  | 'other';

export interface NetworkEntry {
  readonly method: string;
  readonly url: string;
  /** Absent while in flight, or when the request was refused. */
  readonly status?: number | undefined;
  readonly resourceType: ShotResourceType;
  readonly at: number;
  /** `host`: the allow list refused it. The other two are what a scraping driver can also say. */
  readonly refused?: 'blocked' | 'host' | 'robots' | undefined;
}

/** What a screen reader is told about one element — the browser's computed role and name. */
export interface AxNode {
  readonly role: string;
  readonly name: string;
  readonly description?: string | undefined;
  readonly value?: string | undefined;
  readonly focused?: boolean | undefined;
  readonly disabled?: boolean | undefined;
  readonly ignored: boolean;
}

export interface ElementBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** One element as of one observation — a value, never a live handle. */
export interface ElementSnapshot {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly text: string;
  readonly value: string;
  readonly visible: boolean;
  readonly enabled: boolean;
  /** Absent on a driver with no layout engine; never a fabricated zero box. */
  readonly box?: ElementBox | undefined;
  /** Whether a click at the element's centre lands on it. Absent: no layout. */
  readonly hitTarget?: boolean | undefined;
}

/** Each level implies the ones before it. */
export type ActionabilityState = 'attached' | 'visible' | 'enabled' | 'actionable';

export interface WaitOptions {
  readonly state?: ActionabilityState | undefined;
  /** Milliseconds. Falls back to the session's `timeoutMs`. */
  readonly timeout?: number | undefined;
}

export interface AccessibilityOptions {
  readonly max?: number | undefined;
}

/** Every wait goes through this, so a test of a 30-second deadline finishes in microseconds. */
export interface ShotClock extends Clock {
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

export interface ShotPage {
  url(): string;
  /** Refused before a byte leaves when the host is outside the session's `allowHosts`. */
  goto(url: string, options?: { readonly timeout?: number | undefined }): Promise<void>;
  /** Blocks until the first match reaches `state` (default `actionable`), then answers it. */
  waitFor(selector: string, options?: WaitOptions): Promise<ElementSnapshot>;
  click(selector: string, options?: WaitOptions): Promise<void>;
  /** Appends. */
  type(selector: string, text: string, options?: WaitOptions): Promise<void>;
  focus(selector: string, options?: WaitOptions): Promise<void>;
  /** `'Meta+K'`, `'Escape'`, `'Shift+Tab'` — on whatever holds focus. */
  press(chord: string): Promise<void>;
  accessibility(selector: string, options?: AccessibilityOptions): Promise<readonly AxNode[]>;
  query(selector: string): Promise<readonly ElementSnapshot[]>;
  /** The expression's result, `unknown` — parse it, never cast it. */
  evaluate(expression: string): Promise<unknown>;
  /** PNG bytes. */
  screenshot(options?: ShotCapture): Promise<Uint8Array>;
  colorScheme(scheme: ShotColorScheme): Promise<void>;
  /** Runs in every document this page navigates to, before the document's own scripts. */
  prepare(expression: string): Promise<void>;
  /** The bounded tails, and how many entries each bound threw away. */
  console(): readonly ConsoleLine[];
  pageErrors(): readonly PageError[];
  pageErrorsDropped(): number;
  network(): readonly NetworkEntry[];
  networkDropped(): number;
}

export interface ShotSessionInit {
  /** Every error cause raised inside the session carries it. */
  readonly name: string;
  /** Never `*` from a shot: a headless browser inside your network is an SSRF surface. */
  readonly rules: { readonly allowHosts: readonly string[] };
  readonly clock: ShotClock;
  /** Per-operation default, in ms. */
  readonly timeoutMs: number;
  /** CSS pixels the page is laid out in. Absent: the driver's own default. */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  /**
   * Sent on every request the page makes. `x shot` pins `accept-language` here so a picture is of
   * the locale asked for, never of whatever language the machine's Chrome happens to speak.
   */
  readonly headers?: Readonly<Record<string, string>> | undefined;
}

export interface ShotSession {
  readonly page: ShotPage;
  /** Idempotent and never throws: it runs in a `finally`, beside the run's real failure. */
  close(): Promise<void>;
}

export interface ShotDriver {
  readonly name: string;
  open(init: ShotSessionInit): Promise<ShotSession>;
}
