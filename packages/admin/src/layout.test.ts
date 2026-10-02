// The admin shell. Its contract is accessibility and theming, and both are structural: a skip
// link ahead of everything it skips, landmarks with names, `aria-current` on exactly the page you
// are on, a theme that arrives as data attributes plus custom properties — never a colour — and
// no control that needs a script, because an admin screen never hydrates.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog, resetCatalogs } from '@ultimat3/i18n';
import type { AdminApp } from './admin';
import {
  byComponent,
  byTag,
  installFactory,
  one,
  renderShallowNodes,
  restoreFactory,
  withAttr,
} from './inert-jsx';
import type { NavGroup } from './nav';
import { adminBranding, type ThemeTokenRef, themeAttributes } from './theme';

await import('@ultimat3/render/server');
const { AdminLayout, actorLabel } = await import('./layout');

registerCatalog('en', {
  'admin.a11y.skip-to-content': 'Skip to content (probe)',
  'admin.nav.label': 'Sections (probe)',
  'admin.search.label': 'Search (probe)',
  'admin.search.placeholder': 'Find… (probe)',
  'admin.brand.name': 'Acme Admin (probe)',
  'admin.brand.logo': 'Acme logo (probe)',
  'admin.group.data': 'Data (probe)',
  'admin.post.title': 'Posts (probe)',
  'admin.actor.anonymous': 'nobody (probe)',
  'admin.actor.signedIn': '{id} as {roles} (probe)',
  'admin.backToApp': 'Back (probe)',
});

beforeAll(installFactory);
afterAll(() => {
  restoreFactory();
  // The probes above overwrite framework keys (`admin.actor.anonymous`); a later file reads those.
  resetCatalogs();
});

const NAV: readonly NavGroup[] = [
  {
    key: 'admin.group.data',
    labelKey: 'admin.group.data',
    items: [{ key: 'post', labelKey: 'admin.post.title', href: '/posts', entity: 'post' }],
  },
];

const appWith = (over: Partial<AdminApp> = {}): AdminApp =>
  ({
    basePath: '/back-office',
    branding: adminBranding(),
    theme: themeAttributes(adminBranding()),
    ...over,
  }) as AdminApp;

type Nodes = ReturnType<typeof renderShallowNodes>;

const render = (over: Record<string, unknown> = {}): Nodes =>
  renderShallowNodes(AdminLayout, {
    app: appWith(),
    nav: NAV,
    currentPath: '/back-office/posts',
    children: 'the page body',
    ...over,
  });

const root = (nodes: Nodes): ReturnType<typeof one> =>
  one(withAttr(nodes, 'data-admin'), 'the root');

const textOf = (nodes: Nodes, tag: string): readonly unknown[] =>
  byTag(nodes, tag).map((node) => node.props['children']);

describe('the landmarks and the focus order', () => {
  test('the skip link is the FIRST link, and it targets the main region', () => {
    const nodes = render();
    const [skip] = byTag(nodes, 'a');
    expect(skip?.props['children']).toBe('Skip to content (probe)');
    expect(skip?.props['href']).toBe('#x-admin-main');

    const main = one(byTag(nodes, 'main'), '<main>');
    expect(main.props['id']).toBe('x-admin-main');
    // Focusable by script only: the skip link moves focus here, the tab order does not.
    expect(main.props['tabindex']).toBe(-1);
  });

  test('the nav is a NAMED landmark — an unlabelled one is indistinguishable from the pager', () => {
    expect(one(byTag(render(), 'nav'), '<nav>').props['aria-label']).toBe('Sections (probe)');
  });

  test('a title is the screen’s one <h1>; with none the body carries its own', () => {
    expect(textOf(render({ title: 'Posts' }), 'h1')).toEqual(['Posts']);
    expect(byTag(render(), 'h1')).toHaveLength(0);
  });
});

describe('the nav renders what it was handed, and decides nothing', () => {
  test('one section per group, with the group and item labels from their keys', () => {
    const nodes = render();
    expect(textOf(nodes, 'h2')).toEqual(['Data (probe)']);
    const link = byTag(nodes, 'a').find((node) => node.props['children'] === 'Posts (probe)');
    expect(link?.props['href']).toBe('/back-office/posts');
  });

  test('aria-current marks the page you are on, and nothing else', () => {
    const here = withAttr(render(), 'aria-current');
    expect(here).toHaveLength(1);
    expect(here[0]?.props['href']).toBe('/back-office/posts');

    // Same nav, a different URL: no item claims to be current.
    expect(withAttr(render({ currentPath: '/back-office/tags' }), 'aria-current')).toEqual([]);
  });

  test('an empty nav renders the landmark with no sections — visibility is not this file’s call', () => {
    const nodes = render({ nav: [] });
    expect(byTag(nodes, 'nav')).toHaveLength(1);
    expect(byTag(nodes, 'section')).toHaveLength(0);
  });

  test('the way back to the app is always there — the admin’s own table never points home', () => {
    const back = byTag(render({ nav: [] }), 'a').find(
      (node) => node.props['children'] === 'Back (probe)',
    );
    expect(back?.props['href']).toBe('/');
  });
});

describe('who is acting', () => {
  test('a signed-in actor reads as their id and roles', () => {
    expect(actorLabel({ id: 'u_9', roles: ['admin', 'ops'] })).toBe('u_9 as admin, ops (probe)');
    expect(textOf(render({ actor: { id: 'u_9', roles: ['admin'] } }), 'p')).toEqual([
      'u_9 as admin (probe)',
    ]);
  });

  test('absent, null and the anonymous actor all read as "not signed in" — never an empty line', () => {
    expect(actorLabel(undefined)).toBe('nobody (probe)');
    expect(actorLabel(null)).toBe('nobody (probe)');
    expect(actorLabel({ id: 'anonymous', roles: [] })).toBe('nobody (probe)');
    expect(textOf(render(), 'p')).toEqual(['nobody (probe)']);
  });
});

describe('the brand', () => {
  test('with no logo declared, only the name renders — nothing is invented', () => {
    const nodes = render();
    expect(byTag(nodes, 'img')).toHaveLength(0);
    expect(textOf(nodes, 'span')).toEqual(['Acme Admin (probe)']);
    expect(byTag(nodes, 'a')[1]?.props['href']).toBe('/back-office');
  });

  test('a declared logo renders with its ALT from the catalog and its declared width', () => {
    const branding = adminBranding({
      logo: { src: '/logo.svg', altKey: 'admin.brand.logo', width: 40 },
    });
    const nodes = render({ app: appWith({ branding, theme: themeAttributes(branding) }) });
    const img = one(byTag(nodes, 'img'), '<img>');
    expect(img.props['src']).toBe('/logo.svg');
    expect(img.props['alt']).toBe('Acme logo (probe)');
    expect(img.props['width']).toBe(40);
  });

  test('a logo with no width falls back to 24 rather than rendering unsized', () => {
    const branding = adminBranding({ logo: { src: '/logo.svg', altKey: 'admin.brand.logo' } });
    const nodes = render({ app: appWith({ branding, theme: themeAttributes(branding) }) });
    expect(one(byTag(nodes, 'img'), '<img>').props['width']).toBe(24);
  });
});

describe('the theme arrives as data attributes and custom properties', () => {
  test('a pinned mode reaches the root, with the density and the token aliases', () => {
    const branding = adminBranding({
      mode: 'dark',
      density: 'compact',
      accent: '--x-color-brand' as ThemeTokenRef,
    });
    const node = root(render({ app: appWith({ branding, theme: themeAttributes(branding) }) }));

    expect(node.props['data-theme']).toBe('dark');
    expect(node.props['data-density']).toBe('compact');
    // A var() reference, never a colour: this file must not know a hex.
    expect(node.props['style']).toBe('--x-color-accent: var(--x-color-brand);');
  });

  test('under system there is no data-theme, so prefers-color-scheme still decides', () => {
    expect(root(render()).props['data-theme']).toBeUndefined();
  });
});

describe('the search is a native GET — the term rides the URL, and no handler exists', () => {
  test('the form targets the admin’s own search route', () => {
    const form = one(byTag(render(), 'form'), '<form>');
    expect(form.props['method']).toBe('get');
    expect(form.props['action']).toBe('/back-office/search');
    expect(Object.keys(form.props).filter((name) => name.startsWith('on'))).toEqual([]);
  });

  test('the input is labelled, even though the label is visually hidden', () => {
    const nodes = render();
    const label = one(byTag(nodes, 'label'), '<label>');
    const input = one(byComponent(nodes, 'Input'), '<Input>');
    expect(label.props['for']).toBe('x-admin-search-input');
    expect(input.props['id']).toBe('x-admin-search-input');
    expect(input.props['type']).toBe('search');
    // The name the search screen reads off the query string.
    expect(input.props['name']).toBe('term');
    // A placeholder is not a label — both are present on purpose.
    expect(input.props['placeholder']).toBe('Find… (probe)');
    expect(label.props['children']).toBe('Search (probe)');
  });
});

describe('nothing in the shell needs a script', () => {
  test('no element carries an event handler, and no theme or locale control is drawn', () => {
    const nodes = render({ actor: { id: 'u_1', roles: [] }, title: 'Posts' });
    const handlers = nodes.flatMap((node) =>
      Object.keys(node.props).filter((name) => /^on[A-Z]/.test(name)),
    );
    expect(handlers).toEqual([]);
    // Both were a select/button with an `onChange` — dead controls on a page that never hydrates.
    expect(byComponent(nodes, 'ThemeToggle')).toHaveLength(0);
    expect(byComponent(nodes, 'LocaleSwitcher')).toHaveLength(0);
  });
});
