// What an e2e locator SELECTS, as a value, plus the one in-page expression that resolves it.
// `locator`/`getByRole`/`getByText` are lazy handles, so the selection has to survive as data
// until something asks a question about it — and only then does it become a string the browser
// can run.

/** Where the driver parks its click target. Removed again as soon as the click has been made. */
export const MARK_ATTRIBUTE = 'data-x-e2e';

/** One selection, exactly as the test spelled it. `first` is `.first()`, applied at resolve time. */
export type E2eSelection =
  | { readonly kind: 'css'; readonly selector: string; readonly first: boolean }
  | {
      readonly kind: 'role';
      readonly role: string;
      readonly name?: string | undefined;
      readonly level?: number | undefined;
      readonly first: boolean;
    }
  | { readonly kind: 'text'; readonly text: string; readonly first: boolean };

/**
 * What the page answers for one selection. `count` is how many elements matched AFTER `first`
 * narrowed it, `visible` is about the first match alone, and `marked` says the click target now
 * carries `MARK_ATTRIBUTE` — three facts in one round trip, because a locator that asked twice
 * could be answered about two different renders.
 */
export interface E2eResolution {
  readonly count: number;
  readonly visible: boolean;
  readonly marked: boolean;
}

/**
 * The elements that carry a role IMPLICITLY, so `getByRole('button')` finds a `<button>` that
 * never wrote the attribute. A `Map` and not an object literal: the key is a role a test typed,
 * and a computed read of a `Record` answers `Object.prototype` members — the defect
 * `bun run proto-index` exists for.
 *
 * Deliberately not the whole of WAI-ARIA. A role absent from this table still resolves through
 * its explicit `[role="…"]` attribute, which is why an unknown role is not refused: refusing
 * `role="feed"` because a table in the framework is short would be the framework deciding an app's
 * markup is wrong.
 */
const IMPLICIT_ROLE_ELEMENTS = new Map<string, readonly string[]>([
  ['banner', ['header']],
  ['button', ['button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]']],
  ['checkbox', ['input[type="checkbox"]']],
  ['combobox', ['select']],
  ['contentinfo', ['footer']],
  ['dialog', ['dialog']],
  ['form', ['form']],
  ['heading', ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']],
  ['img', ['img']],
  ['link', ['a[href]']],
  ['list', ['ul', 'ol']],
  ['listitem', ['li']],
  ['main', ['main']],
  ['navigation', ['nav']],
  ['option', ['option']],
  ['radio', ['input[type="radio"]']],
  ['table', ['table']],
  ['textbox', ['input[type="text"]', 'input[type="email"]', 'input[type="search"]', 'textarea']],
]);

/** Elements whose text is markup rather than page copy — `getByText` must never land on one. */
const TEXT_SKIP_TAGS = ['SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT'];

/** A CSS attribute selector takes a double-quoted string, which is what `JSON.stringify` writes. */
const roleSelector = (role: string): string =>
  [`[role=${JSON.stringify(role)}]`, ...(IMPLICIT_ROLE_ELEMENTS.get(role) ?? [])].join(',');

/**
 * The call a test wrote, rebuilt from the selection. Every refusal below quotes it, because
 * "an e2e locator matched nothing" names no line of the test file and this does.
 */
export function selectionCall(selection: E2eSelection): string {
  const tail = selection.first ? '.first()' : '';
  if (selection.kind === 'css') return `page.locator(${JSON.stringify(selection.selector)})${tail}`;
  if (selection.kind === 'text') return `page.getByText(${JSON.stringify(selection.text)})${tail}`;
  const options = [
    ...(selection.name === undefined ? [] : [`name: ${JSON.stringify(selection.name)}`]),
    ...(selection.level === undefined ? [] : [`level: ${String(selection.level)}`]),
  ];
  const role = JSON.stringify(selection.role);
  const suffix = options.length === 0 ? '' : `, { ${options.join(', ')} }`;
  return `page.getByRole(${role}${suffix})${tail}`;
}

/**
 * The candidate list, as a JS expression evaluating to an array of elements.
 *
 * `getByRole` and `getByText` are not CSS and cannot be: a role is implicit in a tag name, an
 * accessible name comes off four different attributes before it comes off the text, and
 * `getByText` has to pick the INNERMOST element that contains the string. So the union selector
 * is only the cheap first pass and every rule after it runs in JS, in the page.
 */
function candidateSource(selection: E2eSelection): string {
  if (selection.kind === 'css') return `all(${JSON.stringify(selection.selector)})`;
  if (selection.kind === 'text') {
    const needle = JSON.stringify(selection.text.replace(/\s+/g, ' ').trim().toLowerCase());
    // Innermost FIRST and the skip list second, in that order. Reversed, `<html>` becomes the
    // innermost survivor of a page whose only copy of the string is inside a `<script>` — the
    // ancestor inherits the match its own excluded child made, which is worse than not filtering
    // at all: it reports one match, at the document root, for text no reader can see.
    return `innermost(all('*').filter((el) => norm(el.textContent).toLowerCase().indexOf(${needle}) !== -1)).filter((el) => ${JSON.stringify(TEXT_SKIP_TAGS)}.indexOf(el.tagName) === -1)`;
  }
  const byRole = `all(${JSON.stringify(roleSelector(selection.role))}).filter((el) => { const own = el.getAttribute('role'); return own === null || norm(own).toLowerCase() === ${JSON.stringify(selection.role.toLowerCase())}; })`;
  const byLevel =
    selection.level === undefined
      ? byRole
      : `${byRole}.filter((el) => level(el) === ${String(selection.level)})`;
  return selection.name === undefined
    ? byLevel
    : `${byLevel}.filter((el) => accName(el).toLowerCase() === ${JSON.stringify(selection.name.replace(/\s+/g, ' ').trim().toLowerCase())})`;
}

/**
 * The helpers the candidate source above calls, defined once inside the IIFE.
 *
 * `visible` is `display`/`visibility`/`opacity`, which is character for character what
 * `@ultimat3/scraping`'s `snapshotExpression` computes for `ElementSnapshot.visible`. That is a
 * COPY and it is the wrong shape: `ScrapeTarget.query()` already answers a snapshot per element
 * and `ScrapeFrame` does not expose it, so this driver cannot reach the framework's one definition
 * of visible without an edit to `packages/scraping/src/page.ts`. Mirrored deliberately rather than
 * invented, so the two cannot disagree about a page until that edit lands.
 */
const HELPERS = `
  const norm = (s) => (s || '').replace(/\\s+/g, ' ').trim();
  const all = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
  const innermost = (found) => found.filter((el) => !found.some((other) => other !== el && el.contains(other)));
  const level = (el) => {
    const aria = el.getAttribute('aria-level');
    if (aria !== null) return Number(aria);
    const tag = el.tagName.toLowerCase();
    return /^h[1-6]$/.test(tag) ? Number(tag.slice(1)) : undefined;
  };
  const accName = (el) => {
    const label = el.getAttribute('aria-label');
    if (label !== null && norm(label) !== '') return norm(label);
    const by = el.getAttribute('aria-labelledby');
    if (by !== null) {
      const parts = norm(by).split(' ').map((id) => document.getElementById(id)).filter((n) => n).map((n) => norm(n.textContent));
      if (norm(parts.join(' ')) !== '') return norm(parts.join(' '));
    }
    const tag = el.tagName.toLowerCase();
    if (tag === 'input') { const v = el.getAttribute('value'); if (v !== null && norm(v) !== '') return norm(v); }
    if (tag === 'img') { const a = el.getAttribute('alt'); if (a !== null) return norm(a); }
    const text = norm(el.textContent);
    if (text !== '') return text;
    const title = el.getAttribute('title');
    return title !== null ? norm(title) : '';
  };`;

/**
 * Returns JSON TEXT rather than an object, the same bargain `cdp-snapshot.ts` makes: a CDP round
 * trip serialises the answer anyway, and a string has ONE deserialiser — a schema parse — instead
 * of an implicit one inside the browser library plus a cast on this side.
 */
export function selectionExpression(selection: E2eSelection, mark?: string): string {
  const marker = mark === undefined ? 'null' : JSON.stringify(mark);
  return `(() => {${HELPERS}
  const found = ${candidateSource(selection)};
  const matches = ${selection.first ? 'found.slice(0, 1)' : 'found'};
  const el = matches[0];
  let visible = false;
  if (el) {
    const style = getComputedStyle(el);
    visible = style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }
  const mark = ${marker};
  let marked = false;
  if (mark !== null && el) { el.setAttribute(${JSON.stringify(MARK_ATTRIBUTE)}, mark); marked = true; }
  return JSON.stringify({ count: matches.length, visible: visible, marked: marked });
})()`;
}

/** The CSS the marked element answers to — what `ScrapePage.click` is handed once one is marked. */
export const markSelector = (mark: string): string => `[${MARK_ATTRIBUTE}=${JSON.stringify(mark)}]`;

/** Undo. Best effort by design: a click that navigated took the whole document with it. */
export const unmarkExpression = (mark: string): string =>
  `(() => { const el = document.querySelector(${JSON.stringify(markSelector(mark))}); if (el) el.removeAttribute(${JSON.stringify(MARK_ATTRIBUTE)}); return JSON.stringify(true); })()`;
