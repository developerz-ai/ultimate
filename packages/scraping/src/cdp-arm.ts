// Everything `cdpTarget()` arms on the page BEFORE its first navigation, plus the readers that
// turn the library's `unknown` event payloads into ring entries. Split out of `cdp-target.ts` on
// 2026-09-19 for one reason: that file stood at 478 lines against the 500-line ceiling, and the
// three verbs `press`/`focus`/`accessibility` did not fit under it. The extraction is VERBATIM —
// the request, console, `pageerror` and `error` handlers are the same code, one file over.

import type { CdpPageLike, CdpRequestLike } from './cdp-port';
import type { ScrapeClock } from './clock';
import type { InterceptRules } from './intercept';
import { interceptVerdict, refusalEntry } from './intercept';
import type {
  ConsoleLine,
  ConsoleRing,
  NetworkRing,
  PageError,
  PageErrorRing,
  ResourceType,
} from './rings';
import { pageErrorEntry, RESOURCE_TYPES } from './rings';

/** What `arm()` reads: the page it subscribes to, the rules it judges by, the clock it stamps with. */
export interface CdpArmInit {
  readonly page: CdpPageLike;
  readonly rules: InterceptRules;
  readonly clock: ScrapeClock;
}

const asResourceType = (raw: string): ResourceType =>
  (RESOURCE_TYPES as readonly string[]).includes(raw) ? (raw as ResourceType) : 'other';

/** The library's event payloads are `unknown` here — read structurally, never cast. */
const asRequest = (payload: unknown): CdpRequestLike | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const candidate = payload as Partial<CdpRequestLike>;
  return typeof candidate.url === 'function' && typeof candidate.abort === 'function'
    ? (candidate as CdpRequestLike)
    : undefined;
};

/**
 * CDP's console levels, mapped onto this package's five. `warning` is the library's spelling of
 * `warn`, `verbose` of `debug`, and everything structural (`table`, `startGroup`, `dir`) is a log
 * line with a shape — never its own level, because `ConsoleLine.level` is what an author filters on.
 */
const CONSOLE_LEVELS: Readonly<Record<string, ConsoleLine['level']>> = {
  error: 'error',
  assert: 'error',
  warning: 'warn',
  warn: 'warn',
  info: 'info',
  debug: 'debug',
  verbose: 'debug',
};

/**
 * `Object.hasOwn`, never the read alone: the type word arrives off the WIRE, so
 * `CONSOLE_LEVELS['__proto__']` answered `Object.prototype` and `['constructor']` the `Object`
 * function — neither of which a `?? 'log'` fallback can rescue, because neither is `undefined`.
 * `ConsoleLine.level` would then hold a value its own type says is one of five words, so the
 * `level === 'error'` filter this ring exists for matched nothing and `JSON.stringify` dropped
 * the field from a snapshot outright. Lowercasing is not the guard: `__proto__` and `constructor`
 * are already lowercase. Same discriminator as `packages/flags/src/subject.ts`.
 */
const consoleLevel = (type: string): ConsoleLine['level'] => {
  const word = type.toLowerCase();
  return Object.hasOwn(CONSOLE_LEVELS, word) ? (CONSOLE_LEVELS[word] ?? 'log') : 'log';
};

/**
 * Reads a string out of somebody else's event payload, calling an accessor THROUGH ITS OWNER.
 *
 * `HTTPRequest.method()` and `ConsoleMessage.type()`/`.text()` read `this` — they are methods on
 * the library's own objects, not closures over a value. Handing the bare function to a helper
 * (`readString(request.method)`) drops the receiver, so the accessor answers against `undefined`:
 * on one build that throws inside the interception handler, on another it answers wrong.
 */
const readStringFrom = (owner: unknown, key: string): string | undefined => {
  if (typeof owner !== 'object' || owner === null) return undefined;
  const value = (owner as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (typeof value !== 'function') return undefined;
  const answer = (value as (this: unknown) => unknown).call(owner);
  return typeof answer === 'string' ? answer : undefined;
};

/**
 * A `pageerror` payload, read defensively — never cast, and never assumed to be an `Error`.
 *
 * `readStringFrom`, the same reader the console handler uses, because the payload has the same
 * problem: `message` and `stack` are an own property on one build and an accessor on another, and
 * a schema parse cannot call an accessor. A page can also `throw 'a string'` or throw a frozen
 * object with no `message` at all — both reach here, and both are recorded as SOMETHING having
 * thrown, because an entry with a poor message is still the difference between "the island threw"
 * and silence.
 */
const readPageError = (payload: unknown, at: number): PageError => {
  if (typeof payload === 'string') return pageErrorEntry({ message: payload, at });
  return pageErrorEntry({
    message: readStringFrom(payload, 'message') ?? '',
    stack: readStringFrom(payload, 'stack'),
    at,
  });
};

/**
 * Everything `arm()` writes into. Named rather than positional: three rings of near-identical
 * type plus a latch is a call site nobody can read, and swapping two of them is a mistake the
 * compiler cannot catch.
 */
export interface CdpSinks {
  readonly network: NetworkRing;
  readonly console: ConsoleRing;
  readonly pageErrors: PageErrorRing;
  readonly crashed: { value: string | undefined };
}

/**
 * Interception is armed BEFORE the first navigation and refuses at the request, not after the
 * response — an `allowHosts` that reported afterwards would be a log line about bytes that
 * already left the container.
 */
export async function arm(init: CdpArmInit, sinks: CdpSinks): Promise<void> {
  const { network, console: console_, pageErrors, crashed } = sinks;
  await init.page.setRequestInterception(true);
  init.page.on('request', (payload) => {
    const request = asRequest(payload);
    if (request === undefined) return;
    const url = request.url();
    const type = asResourceType(request.resourceType());
    // The METHOD the browser is actually sending. Recording every request as a GET made
    // `page.network()` — which `X_SCRAPE_HTTP_FAILED`'s own fix line tells the reader to open —
    // misreport every POST and PUT the page made.
    const method = readStringFrom(request, 'method') ?? 'GET';
    const verdict = interceptVerdict(url, type, init.rules);
    const at = init.clock.now().getTime();
    if (verdict === 'allow') {
      network.push({ method, url, resourceType: type, at });
      // Caught, never floated: both reject when the target closed mid-request (and on any other
      // protocol error), and a floated rejection is one Bun ends the process on. The request is
      // already recorded; there is nothing left to do for a target that is gone.
      request.continue().catch(() => undefined);
      return;
    }
    network.push(refusalEntry(url, type, verdict, at, method));
    request.abort().catch(() => undefined);
  });
  init.page.on('console', (payload) => {
    console_.push({
      level: consoleLevel(readStringFrom(payload, 'type') ?? ''),
      text: readStringFrom(payload, 'text') ?? '',
      at: init.clock.now().getTime(),
    });
  });
  /**
   * The page threw and nothing caught it. THE gap this ring closes: a screenshot of an island
   * that threw during hydration is a picture of the server-rendered markup, indistinguishable
   * from a page that worked — and `console` does not carry it, because throwing calls no console
   * method. Subscribed here, beside the others, so a target is observing before its first
   * navigation: an exception raised during load has no second chance to be recorded.
   *
   * NOT the same event as `error` below, and the difference is the whole reason this is a
   * separate handler: puppeteer's `pageerror` is "an uncaught exception happens within the page"
   * and its `error` is "the page crashes" (`PageEvent.PageError` / `PageEvent.Error`). One is the
   * app being broken and the session is fine; the other is the tab being gone. Recording a
   * `pageerror` into `crashed` would make every scrape of a page with one bad island answer
   * X_SCRAPE_PAGE_CRASHED — a code registered `terminal` — for a page still perfectly usable.
   */
  init.page.on('pageerror', (payload) => {
    pageErrors.push(readPageError(payload, init.clock.now().getTime()));
  });
  // A renderer that dies must be a CODE, not a hang: every later call answers X_SCRAPE_PAGE_CRASHED
  // instead of waiting out its own timeout against a tab that is gone.
  init.page.on('error', (payload) => {
    crashed.value = readStringFrom(payload, 'message') ?? 'renderer crashed';
  });
}
