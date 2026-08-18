// What "the element is ready" means, in one place. `page.click` in a raw driver waits for the
// SELECTOR and nothing else, so every app that has ever used one re-learns the same lesson and
// writes the same `waitForTimeout(800)` — or the same hand-rolled
// `waitForSelector('#aceptar:not([disabled])')`, which is this rule, spelled once, by hand, at
// one call site out of forty.

import type { ScrapeClock } from './clock';
import { deadline } from './clock';
import { notActionable, selectorMissing } from './error-throws';
import type { ElementSnapshot } from './target';

/** What a caller needs to be true before it acts. Each level implies the ones above it. */
export type ActionabilityState = 'attached' | 'visible' | 'enabled' | 'actionable';

export const DEFAULT_POLL_MS = 50;

const sameBox = (a: ElementSnapshot, b: ElementSnapshot): boolean =>
  a.box === undefined || b.box === undefined
    ? true
    : a.box.x === b.box.x &&
      a.box.y === b.box.y &&
      a.box.width === b.box.width &&
      a.box.height === b.box.height;

/**
 * Stability, as an observation rather than as a timer: two consecutive polls that agree on
 * everything this package can see. A layout-carrying driver compares boxes and so catches an
 * element still sliding in from a CSS transition; a DOM-only driver compares text, value and
 * attributes and so catches one still being re-rendered. Neither sleeps 800ms and hopes.
 */
export const isStable = (
  current: ElementSnapshot,
  previous: ElementSnapshot | undefined,
): boolean =>
  previous !== undefined &&
  sameBox(current, previous) &&
  current.text === previous.text &&
  current.value === previous.value &&
  current.enabled === previous.enabled &&
  current.visible === previous.visible;

/**
 * Why this snapshot is not yet ready for `state`, or `undefined` when it is.
 *
 * `hitTarget === undefined` means the driver has no layout engine, so nothing here can decide
 * whether something covers the element — and it is NOT read as "covered". The divergence is
 * deliberate, and `driver-parity.test.ts` pins it in one place: a fake that answered `false` would
 * make every click in every offline test fail, and one that fabricated `true` on a real browser
 * would hide the cookie banner that eats the click.
 */
export function actionabilityProblem(
  current: ElementSnapshot,
  previous: ElementSnapshot | undefined,
  state: ActionabilityState,
): string | undefined {
  if (state === 'attached') return undefined;
  if (!current.visible) return 'not visible';
  if (current.box !== undefined && (current.box.width === 0 || current.box.height === 0))
    return 'has a zero-sized box';
  if (state === 'visible') return undefined;
  if (!current.enabled) return 'disabled';
  if (state === 'enabled') return undefined;
  if (current.hitTarget === false) return 'covered by another element at its centre';
  if (!isStable(current, previous)) return 'still moving';
  return undefined;
}

export interface ActionabilityWait {
  readonly selector: string;
  readonly url: string;
  readonly state: ActionabilityState;
  readonly timeoutMs: number;
  readonly clock: ScrapeClock;
  readonly pollMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
  /** Re-read from the live page on EVERY poll. Never a handle captured before the loop. */
  snapshot(): Promise<ElementSnapshot | undefined>;
}

/**
 * Poll until the element reaches `state`, or refuse with the reason it never did. Two codes and
 * they are genuinely different questions: `X_SCRAPE_SELECTOR_MISSING` says the page does not have
 * this element (the markup changed), `X_SCRAPE_NOT_ACTIONABLE` says it does and something is in
 * the way (a modal, a spinner, a disabled submit). Collapsing them into one timeout is what makes
 * a scraper failure take an afternoon.
 */
export async function awaitActionable(wait: ActionabilityWait): Promise<ElementSnapshot> {
  const budget = deadline(wait.clock, wait.timeoutMs);
  const pollMs = wait.pollMs ?? DEFAULT_POLL_MS;
  let previous: ElementSnapshot | undefined;
  let lastProblem: string | undefined;
  let everSeen = false;
  for (;;) {
    const current = await wait.snapshot();
    if (current !== undefined) {
      everSeen = true;
      lastProblem = actionabilityProblem(current, previous, wait.state);
      if (lastProblem === undefined) return current;
      previous = current;
    }
    if (budget.expired()) break;
    await wait.clock.sleep(Math.min(pollMs, budget.remainingMs()), wait.signal);
  }
  if (!everSeen) throw selectorMissing(wait.selector, wait.url, wait.timeoutMs);
  throw notActionable(wait.selector, lastProblem ?? 'never became actionable', wait.timeoutMs);
}
