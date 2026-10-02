// The swap, step by step, over the fake DOM: what the head keeps and loses, stylesheets before the
// swap and retired after it, islands disposed unless carried, a persisted element's attributes and
// active item re-synced, scripts re-created so they run — once. Chrome proves the same end to end.
import { describe, expect, test } from 'bun:test';
import { FakeDocument, type FakeElement, h, routerHead } from './navigation-dom-fixture';
import {
  disposeIslands,
  documentHead,
  headPlan,
  loadStylesheets,
  missingStylesheets,
  notePersisted,
  persistedPairs,
  runScripts,
  swapDocument,
  syncPersisted,
} from './navigation-swap';

const dom = (doc: FakeDocument) => doc as unknown as Document;
const el = (node: FakeElement) => node as unknown as Element;
const els = (nodes: readonly FakeElement[]) => nodes as unknown as Element[];

describe('headPlan', () => {
  test('diffs by markup; never a script that runs, never a stylesheet; JSON-LD is replaced', () => {
    const doc = new FakeDocument(
      routerHead('A', [
        h('meta', { name: 'description', content: 'a' }),
        h('script', { type: 'application/ld+json' }, '{"name":"A"}'),
        h('script', {}, 'theme()'),
        h('link', { rel: 'stylesheet', href: '/a.css' }),
      ]),
    );
    const next = new FakeDocument(
      routerHead('B', [
        h('meta', { name: 'description', content: 'b' }),
        h('script', { type: 'application/ld+json' }, '{"name":"B"}'),
      ]),
    );
    const plan = headPlan(els(doc.head.children), els(next.head.children));
    const tags = (list: readonly Element[]) =>
      list.map((e) => (e as unknown as FakeElement).outerHTML);
    expect(tags(plan.remove)).toEqual([
      '<title>A</title>',
      '<meta name="description" content="a"></meta>',
      '<script type="application/ld+json">{"name":"A"}</script>',
    ]);
    expect(tags(plan.add)).toEqual([
      '<title>B</title>',
      '<meta name="description" content="b"></meta>',
      '<script type="application/ld+json">{"name":"B"}</script>',
    ]);
  });
});

describe('stylesheets', () => {
  test('only the ones not loaded yet, resolved against the base', () => {
    const doc = new FakeDocument([h('link', { rel: 'stylesheet', href: '/a.css' })]);
    const next = new FakeDocument([
      h('link', { rel: 'stylesheet', href: '/a.css' }),
      h('link', { rel: 'stylesheet', href: 'b.css' }),
    ]);
    expect(missingStylesheets(dom(doc), dom(next))).toEqual(['https://app.test/b.css']);
  });

  test('a sheet that fails to load does not hang the navigation; each one is owned', async () => {
    const doc = new FakeDocument();
    const owned = new WeakSet<Element>();
    await loadStylesheets(
      dom(doc),
      ['https://app.test/ok.css', 'https://app.test/fail.css'],
      owned,
    );
    const links = doc.head.querySelectorAll('link');
    expect(links.map((l) => l.getAttribute('href'))).toEqual([
      'https://app.test/ok.css',
      'https://app.test/fail.css',
    ]);
    // Owned as appended: a navigation aborted before its swap leaves nothing the next swap
    // cannot retire.
    expect(links.map((l) => owned.has(l as unknown as Element))).toEqual([true, true]);
  });
});

describe('islands', () => {
  test('disposed through what mount returned — unless kept, unbooted, or failed', async () => {
    const disposed: string[] = [];
    const island = (name: string, boot?: Promise<unknown>) => {
      const node = h('div', { 'data-x-island': name });
      if (boot !== undefined) node.__x = boot;
      return node;
    };
    const kept = island(
      'kept',
      Promise.resolve(() => disposed.push('kept')),
    );
    const root = h('div', {}, [
      island(
        'a',
        Promise.resolve(() => disposed.push('a')),
      ),
      island('not-a-function', Promise.resolve('value')),
      island('failed', Promise.reject(new TypeError('mount threw'))),
      island('never-booted'),
      kept,
    ]);
    const count = disposeIslands(el(root), (node) => node === el(kept));
    await Promise.resolve();
    await Promise.resolve();
    expect(count).toBe(3);
    expect(disposed).toEqual(['a']);
  });
});

describe('persisted elements', () => {
  test('pairs only ids present in both; an empty id pairs nothing', () => {
    const current = h('body', {}, [
      h('aside', { 'data-x-persist': 'shell' }),
      h('div', { 'data-x-persist': 'only-here' }),
      h('div', { 'data-x-persist': '' }),
    ]);
    const next = h('body', {}, [
      h('aside', { 'data-x-persist': 'shell' }),
      h('div', { 'data-x-persist': '' }),
      h('div', { 'data-x-persist': 'only-there' }),
    ]);
    const pairs = persistedPairs(el(current), el(next));
    expect(pairs.map(([live]) => live.getAttribute('data-x-persist'))).toEqual(['shell']);
  });

  test("the root takes the next page's attributes; a script's stay; runtime markers stay", () => {
    const doc = new FakeDocument(
      [],
      [h('aside', { 'data-x-persist': 's', 'data-page': 'a', class: 'x' })],
    );
    const kept = doc.body.children[0] as FakeElement;
    notePersisted(dom(doc));
    kept.setAttribute('data-open', 'yes');
    kept.setAttribute('data-x-mounted', '');
    syncPersisted(el(kept), el(h('aside', { 'data-x-persist': 's', class: 'y' })));
    expect(Object.fromEntries(kept.attrs)).toEqual({
      'data-x-persist': 's',
      class: 'y',
      'data-open': 'yes',
      'data-x-mounted': '',
    });
  });

  test('the active item moves — matched by id, else by place — and its class with it', () => {
    const kept = h('nav', { 'data-x-persist': 'nav' }, [
      h('a', { href: '/a', class: 'on', 'aria-current': 'page' }, 'a'),
      h('a', { href: '/b' }, 'b'),
      h('a', { id: 'help', href: '/help' }, 'help'),
      h('span', { 'aria-current': 'step' }),
    ]);
    const incoming = h('nav', { 'data-x-persist': 'nav' }, [
      h('a', { href: '/a' }, 'a'),
      h('a', { href: '/b', class: 'on', 'aria-current': 'page' }, 'b'),
      h('a', { id: 'help', href: '/help', 'aria-current': 'true' }, 'help'),
      // A different element at that place: no counterpart, so the live one only loses its mark.
      h('em'),
    ]);
    syncPersisted(el(kept), el(incoming));
    expect(
      kept.children.map((c) => `${c.getAttribute('aria-current')}:${c.getAttribute('class')}`),
    ).toEqual(['null:null', 'page:on', 'true:null', 'null:null']);
  });

  test('a node detached from its root has no counterpart', () => {
    const kept = h('nav', {}, [h('a', { 'aria-current': 'page' })]);
    const incoming = h('nav');
    const orphan = kept.children[0] as FakeElement;
    orphan.parentElement = null;
    kept.children = [orphan];
    syncPersisted(el(kept), el(incoming));
    expect(orphan.getAttribute('aria-current')).toBeNull();
  });
});

describe('runScripts', () => {
  test('re-created in order: a src once per tab, inline every time, JSON never', async () => {
    const doc = new FakeDocument();
    const body = h('body', {}, [
      h('script', { type: 'application/json' }, '{}'),
      h('script', { src: '/boot.js', defer: '' }),
      h('script', { src: '/seen.js' }),
      h('script', { type: 'module' }, 'hydrate()'),
      h('script', { src: '/fail.js' }),
    ]);
    doc.documentElement.replaceChild(doc.adoptNode(body), doc.body);
    const inline = body.children[3] as FakeElement;
    inline.nonce = 'n0nce';
    const ran = new Set(['https://app.test/seen.js']);
    await runScripts(
      body.querySelectorAll('script') as unknown as HTMLScriptElement[],
      ran,
      (fresh, inert) => inert.replaceWith(fresh),
    );
    expect(doc.ran).toEqual(['/boot.js', 'hydrate()', '/fail.js']);
    expect([...ran].sort()).toEqual([
      'https://app.test/boot.js',
      'https://app.test/fail.js',
      'https://app.test/seen.js',
    ]);
    expect(body.querySelector('script[type="module"]')?.nonce).toBe('n0nce');
  });
});

describe('swapDocument', () => {
  test('one swap: body, persisted node, head level, sheets retired, lang/dir, head scripts to run', async () => {
    const doc = new FakeDocument(
      routerHead('A', [
        h('link', { rel: 'stylesheet', href: '/a.css' }),
        h('link', { rel: 'stylesheet', href: '/shared.css' }),
        h('script', {}, 'theme()'),
        h('script', {}, 'onlyOnA()'),
      ]),
      [h('aside', { 'data-x-persist': 'shell', id: 'kept' }), h('main', {}, 'A')],
      'en',
    );
    doc.documentElement.setAttribute('dir', 'ltr');
    const owned = documentHead(dom(doc));
    // A sheet a script added: the tab's, never retired.
    doc.head.append(h('link', { rel: 'stylesheet', href: '/runtime.css' }));
    const kept = doc.getElementById('kept') as FakeElement;
    const next = new FakeDocument(
      routerHead('B', [
        h('link', { rel: 'stylesheet', href: '/shared.css' }),
        h('link', { rel: 'stylesheet', href: '/b.css' }),
        h('script', {}, 'theme()'),
        h('script', {}, 'onlyOnB()'),
        h('script', { src: '/b.js' }),
      ]),
      [h('aside', { 'data-x-persist': 'shell', id: 'kept' }), h('main', {}, 'B')],
      'es',
    );
    const swapped = swapDocument(dom(doc), dom(next), owned);
    expect(doc.title).toBe('B');
    expect(doc.getElementById('kept')).toBe(kept);
    expect(doc.body.querySelector('main')?.textContent).toBe('B');
    expect(doc.documentElement.getAttribute('lang')).toBe('es');
    expect(doc.documentElement.hasAttribute('dir')).toBe(false);
    expect(doc.head.querySelectorAll('link').map((l) => l.getAttribute('href'))).toEqual([
      '/shared.css',
      '/runtime.css',
    ]);
    // The next page's own sheet is not the swap's to add: the controller loads it BEFORE swapping.
    expect(swapped.headScripts.map((s) => s.getAttribute('src') ?? s.textContent)).toEqual([
      'onlyOnB()',
      '/b.js',
    ]);
    expect(doc.head.querySelectorAll('script:not([src])').map((s) => s.textContent)).toEqual([
      'theme()',
    ]);
  });
});
