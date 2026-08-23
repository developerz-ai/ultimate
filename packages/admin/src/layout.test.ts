// The admin shell. Its contract is accessibility and theming, and both are structural: a skip
// link ahead of the header, landmarks with names, `aria-current` on exactly the page you are on,
// and a theme that arrives as data attributes plus custom properties — never a colour.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminApp } from './admin';
import {
  byComponent,
  byTag,
  fire,
  installFactory,
  one,
  renderShallowNodes,
  restoreFactory,
  withAttr,
} from './inert-jsx';
import type { NavGroup } from './nav';
import { adminBranding, type ThemeTokenRef, themeAttributes } from './theme';

await import('@ultimat3/render/server');
const { AdminLayout } = await import('./layout');

registerCatalog('en', {
  'admin.a11y.skip-to-content': 'Skip to content (probe)',
  'admin.nav.label': 'Sections (probe)',
  'admin.search.label': 'Search (probe)',
  'admin.search.placeholder': 'Find… (probe)',
  'admin.brand.name': 'Acme Admin (probe)',
  'admin.brand.logo': 'Acme logo (probe)',
  'admin.group.data': 'Data (probe)',
  'admin.post.title': 'Posts (probe)',
});

beforeAll(installFactory);
afterAll(restoreFactory);

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

interface Rendered {
  readonly nodes: ReturnType<typeof renderShallowNodes>;
  readonly searches: string[];
}

function render(over: Record<string, unknown> = {}): Rendered {
  const searches: string[] = [];
  const nodes = renderShallowNodes(AdminLayout, {
    app: appWith(),
    nav: NAV,
    currentPath: '/back-office/posts',
    onSearch: (term: string) => searches.push(term),
    children: 'the page body',
    ...over,
  });
  return { nodes, searches };
}

describe('the landmarks and the focus order', () => {
  test('the skip link is the FIRST element, and it targets the main region', () => {
    const rendered = render();
    const links = byTag(rendered.nodes, 'a');
    const skip = links[0];
    expect(skip?.props['class']).toBe('x-admin-skip');
    expect(skip?.props['href']).toBe('#x-admin-main');
    expect(skip?.props['children']).toBe('Skip to content (probe)');

    const main = one(byTag(rendered.nodes, 'main'), '<main>');
    expect(main.props['id']).toBe('x-admin-main');
    // `tabindex={-1}` is what makes the skip link actually move focus.
    expect(main.props['tabindex']).toBe(-1);
    expect(main.props['children']).toBe('the page body');
  });

  test('the nav is a NAMED landmark — an unlabelled one is indistinguishable from the pager', () => {
    expect(one(byTag(render().nodes, 'nav'), '<nav>').props['aria-label']).toBe('Sections (probe)');
  });
});

describe('the nav renders what it was handed, and decides nothing', () => {
  test('one section per group, with the group and item labels from their keys', () => {
    const rendered = render();
    expect(one(byTag(rendered.nodes, 'h2'), '<h2>').props['children']).toBe('Data (probe)');
    const link = byTag(rendered.nodes, 'a').find(
      (node) => node.props['children'] === 'Posts (probe)',
    );
    expect(link).toBeDefined();
    expect(link?.props['href']).toBe('/back-office/posts');
  });

  test('aria-current marks the page you are on, and nothing else', () => {
    const here = withAttr(render().nodes, 'aria-current');
    expect(here).toHaveLength(1);
    expect(here[0]?.props['href']).toBe('/back-office/posts');

    // Same nav, a different URL: no item claims to be current.
    expect(withAttr(render({ currentPath: '/back-office/tags' }).nodes, 'aria-current')).toEqual(
      [],
    );
  });

  test('an empty nav renders the landmark with no sections — visibility is not this file’s call', () => {
    const rendered = render({ nav: [] });
    expect(byTag(rendered.nodes, 'nav')).toHaveLength(1);
    expect(byTag(rendered.nodes, 'section')).toHaveLength(0);
  });
});

describe('the brand', () => {
  test('with no logo declared, only the name renders — nothing is invented', () => {
    const rendered = render();
    expect(byTag(rendered.nodes, 'img')).toHaveLength(0);
    expect(one(byTag(rendered.nodes, 'span'), '<span>').props['children']).toBe(
      'Acme Admin (probe)',
    );
    expect(
      byTag(rendered.nodes, 'a').find((node) => node.props['class'] === 'x-admin-brand')?.props[
        'href'
      ],
    ).toBe('/back-office');
  });

  test('a declared logo renders with its ALT from the catalog and its declared width', () => {
    const branding = adminBranding({
      logo: { src: '/logo.svg', altKey: 'admin.brand.logo', width: 40 },
    });
    const rendered = render({ app: appWith({ branding, theme: themeAttributes(branding) }) });
    const img = one(byTag(rendered.nodes, 'img'), '<img>');
    expect(img.props['src']).toBe('/logo.svg');
    expect(img.props['alt']).toBe('Acme logo (probe)');
    expect(img.props['width']).toBe(40);
  });

  test('a logo with no width falls back to 24 rather than rendering unsized', () => {
    const branding = adminBranding({ logo: { src: '/logo.svg', altKey: 'admin.brand.logo' } });
    const rendered = render({ app: appWith({ branding, theme: themeAttributes(branding) }) });
    expect(one(byTag(rendered.nodes, 'img'), '<img>').props['width']).toBe(24);
  });
});

describe('the theme arrives as data attributes and custom properties', () => {
  test('a pinned mode reaches the root, with the density and the token aliases', () => {
    const branding = adminBranding({
      mode: 'dark',
      density: 'compact',
      accent: '--x-color-brand' as ThemeTokenRef,
    });
    const rendered = render({ app: appWith({ branding, theme: themeAttributes(branding) }) });
    const root = one(
      byTag(rendered.nodes, 'div').filter((node) => node.props['class'] === 'x-admin'),
      'the root',
    );

    expect(root.props['data-theme']).toBe('dark');
    expect(root.props['data-density']).toBe('compact');
    // A var() reference, never a colour: this file must not know a hex.
    expect(root.props['style']).toBe('--x-color-accent: var(--x-color-brand);');
  });

  test('under system there is no data-theme, so prefers-color-scheme still decides', () => {
    const root = one(
      byTag(render().nodes, 'div').filter((node) => node.props['class'] === 'x-admin'),
      'the root',
    );
    expect(root.props['data-theme']).toBeUndefined();
  });
});

describe('the header search', () => {
  test('the input is labelled, even though the label is visually hidden', () => {
    const rendered = render();
    const label = one(byTag(rendered.nodes, 'label'), '<label>');
    const input = one(byTag(rendered.nodes, 'input'), '<input>');
    expect(label.props['for']).toBe('x-admin-search-input');
    expect(input.props['id']).toBe('x-admin-search-input');
    expect(input.props['type']).toBe('search');
    expect(input.props['name']).toBe('term');
    // A placeholder is not a label — both are present on purpose.
    expect(input.props['placeholder']).toBe('Find… (probe)');
    expect(label.props['children']).toBe('Search (probe)');
  });

  test('submitting is intercepted and reports the typed term', () => {
    const before = Object.getOwnPropertyDescriptor(globalThis, 'HTMLInputElement');
    const beforeForm = Object.getOwnPropertyDescriptor(globalThis, 'HTMLFormElement');
    class FakeInput {
      value = 'invoices';
    }
    class FakeForm {
      readonly elements = { namedItem: (): unknown => new FakeInput() };
    }
    Object.defineProperty(globalThis, 'HTMLInputElement', {
      value: FakeInput,
      configurable: true,
      writable: true,
    });
    Object.defineProperty(globalThis, 'HTMLFormElement', {
      value: FakeForm,
      configurable: true,
      writable: true,
    });
    try {
      const rendered = render();
      const prevented: number[] = [];
      fire(one(byTag(rendered.nodes, 'form'), '<form>'), 'onSubmit', {
        preventDefault: () => prevented.push(1),
        currentTarget: new FakeForm(),
      });
      expect(prevented).toEqual([1]);
      expect(rendered.searches).toEqual(['invoices']);
    } finally {
      if (before === undefined) Reflect.deleteProperty(globalThis, 'HTMLInputElement');
      else Object.defineProperty(globalThis, 'HTMLInputElement', before);
      if (beforeForm === undefined) Reflect.deleteProperty(globalThis, 'HTMLFormElement');
      else Object.defineProperty(globalThis, 'HTMLFormElement', beforeForm);
    }
  });
});

describe('the header tools', () => {
  test('the locale switcher offers only locales that HAVE a catalog', () => {
    const switcher = one(byComponent(render().nodes, 'LocaleSwitcher'), '<LocaleSwitcher>');
    const locales = switcher.props['locales'] as readonly string[];
    // This file registered `en` above, so it must be there — an option nobody translated is a
    // broken page, which is why the list is the REGISTRY and not a hardcoded set.
    expect(locales).toContain('en');
    expect(byComponent(render().nodes, 'ThemeToggle')).toHaveLength(1);
  });

  test('the locale handler is forwarded so the route owns the change', () => {
    const seen: unknown[] = [];
    const rendered = render({ onLocaleChange: (locale: unknown) => seen.push(locale) });
    const switcher = one(byComponent(rendered.nodes, 'LocaleSwitcher'), '<LocaleSwitcher>');
    (switcher.props['onLocaleChange'] as (locale: string) => void)('es');
    expect(seen).toEqual(['es']);
  });
});
