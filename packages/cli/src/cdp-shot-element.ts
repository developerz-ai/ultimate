// What "the element is ready" means for the raw-CDP shot page: the in-page snapshot of every match
// (layout box and hit-test included, which no DOM-only check can see), and the poll that waits for
// the first match to reach a state. Two refusals, because they are two questions: the page does
// not have the element, or it does and something keeps it from being acted on.
import type { ActionabilityState, ElementSnapshot, ShotClock } from './browser-launcher-port';
import { ShotElementMissingError, ShotElementUnreadyError } from './cdp-shot-errors';

/** JSON text, so the answer has one deserialiser: `parseSnapshots` below. */
export const snapshotExpression = (selector: string): string => `(() => {
  const out = [];
  for (const el of document.querySelectorAll(${JSON.stringify(selector)})) {
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    const attrs = [];
    for (const attribute of el.attributes) attrs.push([attribute.name, attribute.value]);
    const top = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
    out.push({
      tag: el.tagName.toLowerCase(),
      attrs,
      text: (el.textContent || '').replace(/\\s+/g, ' ').trim(),
      value: typeof el.value === 'string' ? el.value : '',
      visible: style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
      enabled: el.disabled !== true && el.getAttribute('aria-disabled') !== 'true',
      box: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      hitTarget: top !== null && (top === el || el.contains(top)),
    });
  }
  return JSON.stringify(out);
})()`;

const record = (value: unknown): Readonly<Record<string, unknown>> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number => (typeof value === 'number' ? value : 0);

/** Attribute pairs, rebuilt with `fromEntries` so a page's `constructor="…"` stays an own key. */
const attrsOf = (value: unknown): Readonly<Record<string, string>> =>
  Object.fromEntries(
    (Array.isArray(value) ? value : [])
      .filter((pair): pair is [string, string] => Array.isArray(pair) && pair.length === 2)
      .map(([name, attr]) => [str(name), str(attr)]),
  );

/** The page's answer is `unknown` until this reads it. A row that is not an element is dropped. */
export function parseSnapshots(raw: unknown): readonly ElementSnapshot[] {
  let rows: unknown;
  try {
    rows = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    return [];
  }
  if (!Array.isArray(rows)) return [];
  const out: ElementSnapshot[] = [];
  for (const row of rows) {
    const el = record(row);
    if (el === undefined || typeof el['tag'] !== 'string') continue;
    const box = record(el['box']);
    out.push({
      tag: el['tag'],
      attrs: attrsOf(el['attrs']),
      text: str(el['text']),
      value: str(el['value']),
      visible: el['visible'] === true,
      enabled: el['enabled'] === true,
      box: {
        x: num(box?.['x']),
        y: num(box?.['y']),
        width: num(box?.['width']),
        height: num(box?.['height']),
      },
      hitTarget: el['hitTarget'] === true,
    });
  }
  return out;
}

const sameBox = (a: ElementSnapshot, b: ElementSnapshot): boolean =>
  a.box?.x === b.box?.x &&
  a.box?.y === b.box?.y &&
  a.box?.width === b.box?.width &&
  a.box?.height === b.box?.height;

/** Why this snapshot is not yet at `state`, or `undefined` when it is. Still = two polls agree. */
export function unreadiness(
  current: ElementSnapshot,
  previous: ElementSnapshot | undefined,
  state: ActionabilityState,
): string | undefined {
  if (state === 'attached') return undefined;
  if (!current.visible) return 'not visible';
  if (current.box !== undefined && (current.box.width === 0 || current.box.height === 0)) {
    return 'a zero-sized box';
  }
  if (state === 'visible') return undefined;
  if (!current.enabled) return 'disabled';
  if (state === 'enabled') return undefined;
  if (current.hitTarget === false) return 'covered by another element at its centre';
  if (previous === undefined || !sameBox(current, previous)) return 'moving';
  return undefined;
}

export const READY_POLL_MS = 50;

export interface ReadyWait {
  readonly selector: string;
  readonly state: ActionabilityState;
  readonly timeoutMs: number;
  readonly clock: ShotClock;
  /** Re-read on every poll: never a handle captured before the loop. */
  readonly snapshot: () => Promise<ElementSnapshot | undefined>;
  readonly url: () => string;
}

/** Poll until the first match reaches `state`, or refuse with the reason it never did. */
export async function awaitReady(wait: ReadyWait): Promise<ElementSnapshot> {
  const started = wait.clock.monotonic();
  let previous: ElementSnapshot | undefined;
  let problem: string | undefined;
  let seen = false;
  for (;;) {
    const current = await wait.snapshot();
    if (current !== undefined) {
      seen = true;
      problem = unreadiness(current, previous, wait.state);
      if (problem === undefined) return current;
      previous = current;
    }
    const left = wait.timeoutMs - (wait.clock.monotonic() - started);
    if (!(left > 0)) break;
    await wait.clock.sleep(Math.max(1, Math.min(READY_POLL_MS, left)));
  }
  if (!seen) {
    throw new ShotElementMissingError({
      selector: wait.selector,
      url: wait.url(),
      timeoutMs: wait.timeoutMs,
    });
  }
  throw new ShotElementUnreadyError({
    selector: wait.selector,
    problem: problem ?? 'not ready',
    timeoutMs: wait.timeoutMs,
  });
}
