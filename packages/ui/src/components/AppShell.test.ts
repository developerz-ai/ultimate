// Below `md` the sidebar is a panel opened by a menu button, and it must open with scripting off:
// an admin screen never hydrates, and a shell on every page that needed an island would charge
// every app's every route for one. So the panel is a native `popover` and the button a
// `popovertarget` — zero script — and an engine without popovers keeps today's band above the
// content. Each half is asserted here: the wiring off the node tree, the fallback off the CSS.

import '../theme/ambient';
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import { byTag, one, type ProbeNode, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { compileScssFile } from '../sass-probe-fixture';
import { AppShell } from './AppShell';

const uiString = (key: string): string => FRAMEWORK_CATALOG[key] ?? `no catalog entry for ${key}`;
const SHEET = Bun.fileURLToPath(new URL('./AppShell.module.scss', import.meta.url));

const shell = (extra: Record<string, unknown> = {}): ProbeNode[] =>
  renderNodes(AppShell, { children: 'body', header: 'top', sidebar: 'links', ...extra });

/** Every text a node holds, flattened — a label may be split across an icon and a span. */
const textOf = (node: ProbeNode | undefined): string => {
  const walk = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.map(walk).join('');
    if (typeof value === 'object' && value !== null && 'props' in value) {
      return walk((value as ProbeNode).props['children']);
    }
    return '';
  };
  return walk(node?.props['children']);
};

describe('AppShell, the sidebar collapses into a panel below md', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the nav is a popover, and the menu button targets it by its id', () => {
    const nodes = shell();
    const nav = one(byTag(nodes, 'nav'), '<nav>');
    const opener = one(
      withAttr(byTag(nodes, 'button'), 'popovertarget', nav.props['id']).filter(
        (node) => node.props['popovertargetaction'] === undefined,
      ),
      'menu button',
    );

    expect(nav.props['popover']).toBe('auto');
    expect(typeof nav.props['id']).toBe('string');
    expect(opener.props['type']).toBe('button');
    // A toggle, so the same button closes it again.
    expect(opener.props['popovertargetaction']).toBeUndefined();
    expect(textOf(opener)).toBe(uiString(UI_KEYS.menu));
  });

  test('the panel carries its own close button, named and aimed at the same nav', () => {
    const nodes = shell();
    const nav = one(byTag(nodes, 'nav'), '<nav>');
    const close = one(withAttr(byTag(nodes, 'button'), 'popovertargetaction', 'hide'), 'close');
    expect(close.props['popovertarget']).toBe(nav.props['id']);
    expect(close.props['aria-label']).toBe(uiString(UI_KEYS.close));
  });

  test('the landmark keeps its name; the header keeps exactly what it was handed', () => {
    const nodes = shell();
    expect(one(byTag(nodes, 'nav'), '<nav>').props['aria-label']).toBe(
      uiString(UI_KEYS.navigation),
    );
    expect(one(byTag(nodes, 'header'), '<header>').props['children']).toBe('top');
  });

  test('the skip link is still the first focusable thing, ahead of the menu button', () => {
    const nodes = shell();
    const focusable = nodes.filter((node) => node.type === 'a' || node.type === 'button');
    expect(focusable[0]?.type).toBe('a');
    expect(focusable[1]?.props['popovertarget']).toBeDefined();
  });

  test('no sidebar, no menu button and no popover — nothing to open', () => {
    const nodes = shell({ sidebar: undefined });
    expect(byTag(nodes, 'button')).toEqual([]);
    expect(withAttr(nodes, 'popover')).toEqual([]);
  });

  // The island budget: the shell is on every page, so its budget is ZERO bytes, and a handler on
  // any node is exactly what would make it an island. The popover does the opening natively.
  test('ships no script: not one node in the frame carries an event handler', () => {
    const handlers = shell().flatMap((node) =>
      Object.entries(node.props)
        .filter(([name, value]) => /^on[A-Z]/.test(name) && typeof value === 'function')
        .map(([name]) => `<${String(node.type)} ${name}>`),
    );
    expect(handlers).toEqual([]);
  });
});

/** The preludes of every block enclosing `index` in compiled CSS, outermost first. */
function enclosing(css: string, index: number): string[] {
  const stack: string[] = [];
  let prelude = 0;
  for (let at = 0; at < index; at += 1) {
    const char = css[at];
    if (char === '{') {
      stack.push(css.slice(prelude, at).trim());
      prelude = at + 1;
    } else if (char === '}') {
      stack.pop();
      prelude = at + 1;
    } else if (char === ';') {
      prelude = at + 1;
    }
  }
  return stack;
}

/** Every innermost rule in compiled CSS: its selectors, its declarations, and its at-rules. */
function rules(css: string): { selectors: string[]; body: string; within: string[] }[] {
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)].map((match) => {
    const at = (match.index ?? 0) + (match[1]?.length ?? 0) - (match[1]?.trimStart().length ?? 0);
    return {
      selectors: (match[1] ?? '').split(',').map((selector) => selector.trim()),
      body: match[2] ?? '',
      within: enclosing(css, at).filter((prelude) => prelude.startsWith('@')),
    };
  });
}

/** The at-rules around the first rule naming `selector` that sets a declaration matching `decl`. */
function contextOf(css: string, selector: string, decl: RegExp): string[] | undefined {
  return rules(css).find((rule) => rule.selectors.includes(selector) && decl.test(rule.body))
    ?.within;
}

const MOBILE = '@media (max-width: 767.98px)';
const POPOVERS = '@supports selector(:popover-open)';

describe('AppShell, the no-popover fallback is in the stylesheet', () => {
  test('the closed panel is hidden ONLY where the engine has popovers, and only below md', async () => {
    const css = await compileScssFile(SHEET);
    // An engine with no popover would otherwise hide a nav nothing can open.
    expect(contextOf(css, '.sidebar:not(:popover-open)', /display:\s*none/)).toEqual([
      MOBILE,
      POPOVERS,
    ]);
  });

  test('the menu button is hidden by default and shown only where it can open something', async () => {
    const css = await compileScssFile(SHEET);
    expect(contextOf(css, '.menuButton', /display:\s*none/)).toEqual([]);
    expect(contextOf(css, '.menuButton', /display:\s*inline-flex/)).toEqual([MOBILE, POPOVERS]);
    expect(contextOf(css, '.close', /display:\s*none/)).toEqual([]);
    expect(contextOf(css, '.close', /display:\s*inline-flex/)).toEqual([MOBILE, POPOVERS]);
  });

  test('the menu and close buttons are touch targets on both axes', async () => {
    const css = await compileScssFile(SHEET);
    for (const selector of ['.menuButton', '.close']) {
      expect(contextOf(css, selector, /min-block-size:\s*var\(--touch-target\)/)).toEqual([]);
      expect(contextOf(css, selector, /min-inline-size:\s*var\(--touch-target\)/)).toEqual([]);
    }
  });

  // An `auto` track is at least its content's min-content width: a header that does not shrink
  // widened the whole page past a 390px viewport.
  test('the single phone column of the frame may shrink below its content', async () => {
    const css = await compileScssFile(SHEET);
    expect(contextOf(css, '.shell', /grid-template-columns:\s*minmax\(0, 1fr\)/)).toEqual([]);
    expect(contextOf(css, '.top', /min-inline-size:\s*0/)).toEqual([]);
  });

  test('below sm the menu button is its icon, its label kept for assistive tech', async () => {
    const css = await compileScssFile(SHEET);
    expect(contextOf(css, '.menuLabel', /clip-path:\s*inset\(50%\)/)).toEqual([
      '@media (max-width: 479.98px)',
    ]);
  });

  test('at md and up the nav is an in-flow column whatever the UA popover sheet says', async () => {
    const css = await compileScssFile(SHEET);
    // Every top-level `.sidebar` block — Sass splits one rule around a mixin's nested rules.
    const base = rules(css)
      .filter((rule) => rule.selectors.includes('.sidebar') && rule.within.length === 0)
      .map((rule) => rule.body)
      .join('');
    // The UA styles every [popover] fixed, centred and hidden; the column undoes each.
    for (const decl of ['display: block', 'position: static', 'inset: auto', 'margin: 0']) {
      expect(base).toContain(decl);
    }
  });

  test('the open panel is an edge sheet with a scrim, below md only', async () => {
    const css = await compileScssFile(SHEET);
    expect(contextOf(css, '.sidebar:popover-open', /position:\s*fixed/)).toEqual([
      MOBILE,
      POPOVERS,
    ]);
    expect(contextOf(css, '.sidebar:popover-open::backdrop', /background/)).toEqual([
      MOBILE,
      POPOVERS,
    ]);
  });
});
