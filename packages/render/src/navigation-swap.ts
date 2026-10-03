/**
 * Puts a fetched document in place of the current one, in one order: its stylesheets loaded (no
 * unstyled frame), this page's islands disposed, the body replaced with persisted elements carried
 * across, the head brought level, and the document's own scripts run — which re-runs the ONE
 * island bootstrap (`hydrate.ts`'s runtime) over the new body. There is no second mount path.
 */

import { NAVIGATION_PERSIST_ATTRIBUTE } from './navigation-rules';

/** What `hydrate.ts`'s runtime leaves on an island root: the boot promise and the visited mark. */
interface IslandElement extends Element {
  __x?: Promise<unknown>;
}

const ISLAND_SELECTOR = '[data-x-island]';
const STYLESHEET = 'link[rel~="stylesheet"]';

const isStylesheet = (el: Element): boolean =>
  el.tagName === 'LINK' && /\bstylesheet\b/i.test(el.getAttribute('rel') ?? '');

/** A script type the parser executes — JSON (island props, JSON-LD) is data. */
const executes = (script: Element): boolean =>
  script.tagName === 'SCRIPT' && !/json$/i.test(script.getAttribute('type') ?? '');

/**
 * Diffed by markup: everything but a script that executes (it ran, or runs through `runScripts`)
 * and a stylesheet (loaded before the swap, retired after it). JSON-LD is data, so it is replaced.
 */
const isDiffed = (el: Element): boolean => !executes(el) && !isStylesheet(el);

/**
 * The head, brought level by MARKUP: a tag identical in both stays (no reflow, no refetch), one
 * only this document has goes, one only the next has arrives. Covers every route-owned tag —
 * title, description, robots, canonical, alternates, Open Graph, JSON-LD — without a list of
 * names that the next SEO tag would be missing from.
 */
export function headPlan(
  current: readonly Element[],
  next: readonly Element[],
): { readonly remove: readonly Element[]; readonly add: readonly Element[] } {
  const have = new Set(current.filter(isDiffed).map((el) => el.outerHTML));
  const want = new Set(next.filter(isDiffed).map((el) => el.outerHTML));
  return {
    remove: current.filter((el) => isDiffed(el) && !want.has(el.outerHTML)),
    add: next.filter((el) => isDiffed(el) && !have.has(el.outerHTML)),
  };
}

/** The next document's stylesheets this one has not loaded, as hrefs. */
export function missingStylesheets(doc: Document, next: Document): readonly string[] {
  const loaded = new Set(
    [...doc.querySelectorAll<HTMLLinkElement>(STYLESHEET)].map((link) => link.href),
  );
  return [...next.querySelectorAll<HTMLLinkElement>(STYLESHEET)]
    .map((link) => new URL(link.getAttribute('href') ?? '', doc.baseURI).href)
    .filter((href) => !loaded.has(href));
}

/**
 * Resolves once every sheet loaded OR failed — a missing sheet must not hang the navigation. Each
 * sheet joins `owned` as it is appended, so a swap that never happens still leaves it retirable.
 */
export function loadStylesheets(
  doc: Document,
  hrefs: readonly string[],
  owned: WeakSet<Element>,
): Promise<void> {
  return Promise.all(
    hrefs.map(
      (href) =>
        new Promise<void>((done) => {
          const link = doc.createElement('link');
          link.rel = 'stylesheet';
          link.href = href;
          link.onload = () => done();
          link.onerror = () => done();
          doc.head.append(link);
          owned.add(link);
        }),
    ),
  ).then(() => undefined);
}

/**
 * Calls each island's disposer — what its `mount` returned, held by `el.__x` — unless the island
 * is carried across. A rejected boot has nothing to dispose, and the rejection is already on the
 * element as `data-x-failed`.
 */
export function disposeIslands(root: Element, kept: (el: Element) => boolean): number {
  let disposed = 0;
  for (const el of root.querySelectorAll<IslandElement>(ISLAND_SELECTOR)) {
    if (kept(el) || el.__x === undefined) continue;
    disposed += 1;
    el.__x.then(
      (dispose) => {
        if (typeof dispose === 'function') dispose();
      },
      () => undefined,
    );
  }
  return disposed;
}

/** `[data-x-persist="id"]` present in BOTH documents: the live element moves into the next body. */
export function persistedPairs(
  current: ParentNode,
  next: ParentNode,
): readonly (readonly [Element, Element])[] {
  const pairs: (readonly [Element, Element])[] = [];
  for (const incoming of next.querySelectorAll(`[${NAVIGATION_PERSIST_ATTRIBUTE}]`)) {
    const id = incoming.getAttribute(NAVIGATION_PERSIST_ATTRIBUTE) ?? '';
    const live = [...current.querySelectorAll(`[${NAVIGATION_PERSIST_ATTRIBUTE}]`)].find(
      (el) => el.getAttribute(NAVIGATION_PERSIST_ATTRIBUTE) === id,
    );
    if (id !== '' && live !== undefined) pairs.push([live, incoming]);
  }
  return pairs;
}

/**
 * Re-creates executable scripts so they run: a script parsed by `DOMParser` is inert wherever it
 * is inserted. A `src` this tab already ran is left alone (the page boot runs once per tab, as it
 * does once per load); an inline one runs again — the hydration runtime, which skips every island
 * it already visited. In document order, each `src` awaited, so a deferred boot still runs before
 * the island modules that follow it. `place` puts the fresh copy where it belongs: in place of the
 * inert one in a body, appended to the head. A `src` is recorded only once it is IN the document.
 */
export async function runScripts(
  scripts: readonly HTMLScriptElement[],
  ran: Set<string>,
  place: (fresh: HTMLScriptElement, inert: HTMLScriptElement) => void,
): Promise<void> {
  for (const inert of scripts) {
    if (!executes(inert)) continue;
    const doc = inert.ownerDocument;
    const src = inert.getAttribute('src');
    const url = src === null ? null : new URL(src, doc.baseURI).href;
    if (url !== null && ran.has(url)) continue;
    const fresh = doc.createElement('script');
    for (const attr of inert.attributes) fresh.setAttribute(attr.name, attr.value);
    // `nonce` is hidden from the attribute once parsed; the property still carries it.
    if (inert.nonce) fresh.nonce = inert.nonce;
    fresh.textContent = inert.textContent;
    if (url === null) {
      place(fresh, inert);
      continue;
    }
    fresh.async = false;
    await new Promise<void>((done) => {
      fresh.onload = () => done();
      fresh.onerror = () => done();
      place(fresh, inert);
      ran.add(url);
    });
  }
}

/**
 * The attributes a server document put on each persisted root: taken when the router starts (before
 * any island or app script has run) and after every sync — the only ones a later page may remove.
 */
const serverAttributes = new WeakMap<Element, ReadonlySet<string>>();

/** Snapshot the document's persisted roots; call once, when the router starts. */
export function notePersisted(doc: Document): void {
  for (const el of doc.querySelectorAll(`[${NAVIGATION_PERSIST_ATTRIBUTE}]`)) {
    serverAttributes.set(el, new Set(el.getAttributeNames()));
  }
}

/** Attributes the hydration runtime sets on an island root: the live element's, never a page's. */
const RUNTIME_ATTRIBUTES: ReadonlySet<string> = new Set(['data-x-mounted', 'data-x-failed']);

/** Where `el` (under `from`) sits under `to`: by id, else by the same child path and tag. */
function counterpart(el: Element, from: Element, to: Element): Element | null {
  if (el.id !== '') {
    const byId = [...to.querySelectorAll('[id]')].find((other) => other.id === el.id);
    if (byId !== undefined) return byId;
  }
  const path: number[] = [];
  for (let at: Element = el; at !== from; ) {
    const parent: Element | null = at.parentElement;
    if (parent === null) return null;
    path.unshift([...parent.children].indexOf(at));
    at = parent;
  }
  let walked: Element | undefined = to;
  for (const index of path) walked = walked?.children[index];
  return walked !== undefined && walked.tagName === el.tagName ? walked : null;
}

/**
 * A persisted element keeps its node, its state and its islands — and takes the incoming page's
 * word for what it SAYS about the page: the root's attributes, and every descendant's
 * `aria-current` with the `class` that styles it (the sidebar's active item moves).
 */
export function syncPersisted(kept: Element, incoming: Element): void {
  // Only what a server document said may be unsaid: an attribute a script set at run time (a
  // collapsed state, an island's marker) is the tab's, and survives like the node it sits on.
  const said = serverAttributes.get(kept) ?? new Set(kept.getAttributeNames());
  for (const name of said) {
    if (!incoming.hasAttribute(name) && !RUNTIME_ATTRIBUTES.has(name)) kept.removeAttribute(name);
  }
  for (const attr of incoming.attributes) kept.setAttribute(attr.name, attr.value);
  serverAttributes.set(kept, new Set(incoming.getAttributeNames()));
  const pairs = new Map<Element, Element | null>();
  for (const el of kept.querySelectorAll('[aria-current]')) {
    pairs.set(el, counterpart(el, kept, incoming));
  }
  for (const el of incoming.querySelectorAll('[aria-current]')) {
    const live = counterpart(el, incoming, kept);
    if (live !== null) pairs.set(live, el);
  }
  for (const [live, next] of pairs) {
    const current = next?.getAttribute('aria-current') ?? null;
    if (current === null) live.removeAttribute('aria-current');
    else live.setAttribute('aria-current', current);
    const cls = next?.getAttribute('class') ?? null;
    if (next !== null && next !== undefined) {
      if (cls === null) live.removeAttribute('class');
      else live.setAttribute('class', cls);
    }
  }
}

/**
 * The head elements a server DOCUMENT put there — the only ones a swap may take away. Anything a
 * script added at run time (a CSS-in-JS `<style>`, an analytics tag, a persisted island's own
 * sheet) is the tab's, not the page's, and outlives every navigation as it would have outlived the
 * page's own scripts.
 */
export function documentHead(doc: Document): WeakSet<Element> {
  return new WeakSet(doc.head.children);
}

/**
 * The swap itself, after the caller decided the answer IS a page for this tab. Synchronous from
 * the dispose to the head, so a view transition's "after" snapshot is one consistent document.
 * `owned` is `documentHead`'s set, kept by the caller across swaps and grown by each one.
 */
export function swapDocument(doc: Document, next: Document, owned: WeakSet<Element>): Swapped {
  // Read before the head moves: `next.title` reads the `<title>` element, which the plan adopts.
  const title = next.title;
  const nextSheets = new Set(
    [...next.head.querySelectorAll('link')]
      .filter(isStylesheet)
      .map((link) => new URL(link.getAttribute('href') ?? '', doc.baseURI).href),
  );
  // Inline head scripts by TEXT: one this page already ran (the theme boot, on every document)
  // is not run again; one only the next page has runs once; one only this page had is dropped.
  const inline = (head: HTMLHeadElement): HTMLScriptElement[] =>
    [...head.querySelectorAll('script')].filter((s) => executes(s) && !s.hasAttribute('src'));
  const ranInline = new Set(inline(doc.head).map((s) => s.textContent));
  const nextInline = new Set(inline(next.head).map((s) => s.textContent));
  const headScripts = [...next.head.querySelectorAll('script')].filter(
    (script) =>
      executes(script) && (script.hasAttribute('src') || !ranInline.has(script.textContent)),
  );
  for (const stale of inline(doc.head)) {
    if (owned.has(stale) && !nextInline.has(stale.textContent)) stale.remove();
  }
  const pairs = persistedPairs(doc.body, next.body);
  const live = pairs.map(([el]) => el);
  disposeIslands(doc.body, (island) => live.some((kept) => kept.contains(island)));
  for (const [kept, incoming] of pairs) {
    syncPersisted(kept, incoming);
    incoming.replaceWith(kept);
  }
  const body = doc.adoptNode(next.body);
  doc.documentElement.replaceChild(body, doc.body);
  const plan = headPlan(
    [...doc.head.children].filter((el) => owned.has(el)),
    [...next.head.children],
  );
  for (const el of plan.remove) el.remove();
  for (const el of plan.add) {
    doc.head.append(doc.adoptNode(el));
    owned.add(el);
  }
  // Retired only now, after the next page's sheets loaded: the previous page's own, never a
  // sheet a script added (not `owned`), never one both pages link.
  for (const sheet of [...doc.head.querySelectorAll('link')].filter(isStylesheet)) {
    const href = new URL(sheet.getAttribute('href') ?? '', doc.baseURI).href;
    if (owned.has(sheet) && !nextSheets.has(href)) sheet.remove();
  }
  for (const sheet of [...doc.head.querySelectorAll('link')].filter(isStylesheet)) {
    if (nextSheets.has(new URL(sheet.getAttribute('href') ?? '', doc.baseURI).href))
      owned.add(sheet);
  }
  // `lang` and `dir` are the document's; `data-theme` and the rest belong to this tab's scripts.
  for (const name of ['lang', 'dir']) {
    const value = next.documentElement.getAttribute(name);
    if (value === null) doc.documentElement.removeAttribute(name);
    else doc.documentElement.setAttribute(name, value);
  }
  doc.title = title;
  return { body, headScripts };
}

/** What the caller still owes the new document once the view transition has painted it. */
export interface Swapped {
  readonly body: HTMLElement;
  /** The next page's `<script src>` in its head, still inert — `runScripts` them into the head. */
  readonly headScripts: readonly HTMLScriptElement[];
}
