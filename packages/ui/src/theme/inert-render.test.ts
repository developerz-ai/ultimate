/**
 * The specification for the server path. A component that reads the ambient presentation context
 * must render through an INERT JSX factory — no DOM, no reactivity, no registered Solid runtime —
 * because that is the only path `@ultimat3/render` has: `h` builds inert nodes and `renderToHtml`
 * calls each component as a plain function. Reactivity that is impossible is not reactivity lost.
 */

import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { configureLocales, type Locale, localeConfig } from '@ultimat3/i18n';
import { configureTime, type TimeZone, timeConfig } from '@ultimat3/time';
import { AppShell } from '../components/AppShell';
import { Breadcrumb } from '../components/Breadcrumb';
import { Combobox } from '../components/Combobox';
import { DataTable } from '../components/DataTable';
import { DateTime } from '../components/DateTime';
import { Dialog } from '../components/Dialog';
import { Drawer } from '../components/Drawer';
import { Dropzone } from '../components/Dropzone';
import { EmptyState } from '../components/EmptyState';
import { ErrorState } from '../components/ErrorState';
import { Field } from '../components/Field';
import { FileInput } from '../components/FileInput';
import { InfiniteScroll } from '../components/InfiniteScroll';
import { LocaleSwitcher } from '../components/LocaleSwitcher';
import { Menu } from '../components/Menu';
import { Money } from '../components/Money';
import { Pagination } from '../components/Pagination';
import { Popover } from '../components/Popover';
import { RelativeTime } from '../components/RelativeTime';
import { Select } from '../components/Select';
import { Spinner } from '../components/Spinner';
import { Tabs } from '../components/Tabs';
import { Textarea } from '../components/Textarea';
import { ThemeToggle } from '../components/ThemeToggle';
import { Toast } from '../components/Toast';
import { Toolbar } from '../components/Toolbar';
import { UI_ERROR_CODES } from '../errors';
import { UiProvider } from './provider';
import { clearSolidRuntime } from './runtime-slot';

// --- the inert factory ---------------------------------------------------------------------
// A local copy of `@ultimat3/render`'s `h` + `renderToHtml`, ~30 lines of it. This package may
// not import `@ultimat3/render` (its `.tsx` compiles to that factory, which is exactly why the
// import would be circular), and the fidelity this test needs is small: a component is a function
// of props, a thunk is called, and nothing reactive exists.

interface JsxLike {
  readonly type: string | ((props: Record<string, unknown>) => unknown);
  readonly props: Record<string, unknown>;
}

interface InertNode extends JsxLike {
  readonly inert: true;
}

function h(
  type: string | ((props: Record<string, unknown>) => unknown),
  props: Record<string, unknown> | null,
  ...children: readonly unknown[]
): InertNode {
  const base = { ...(props ?? {}) };
  if (children.length > 0) base['children'] = children.length === 1 ? children[0] : children;
  return { inert: true, type, props: base };
}

/**
 * `@ultimat3/render`'s node brand, read off the GLOBAL symbol registry rather than by importing
 * the package this one may not depend on — which is exactly why the symbol is registered there.
 *
 * Which factory these components compile to is NOT this file's to choose: `render/src/index.ts`
 * installs a process-global `Bun.plugin` `onLoad` for `/\.tsx$/` at import, and `bun test` is one
 * process, so any other file in the run that imports `@ultimat3/render` first wins. Both factories
 * build the same shape — a `type` and a `props` with children in `props.children` — so this walker
 * understands both and the run's file order stops deciding the result. Recognising neither is what
 * used to fall through to `String(value)` and assert against `"[object Object]"`.
 */
const RENDER_NODE: symbol = Symbol.for('ultimate.render.jsx');

const isNode = (value: unknown): value is JsxLike =>
  typeof value === 'object' && value !== null && ('inert' in value || RENDER_NODE in value);

const SKIPPED_PROPS = new Set(['children', 'ref', 'innerHTML']);

function attributes(props: Record<string, unknown>): string {
  return Object.entries(props)
    .filter(([name, value]) => {
      if (SKIPPED_PROPS.has(name) || name.startsWith('on')) return false;
      return value !== undefined && value !== null && value !== false;
    })
    .map(([name, value]) => (value === true ? ` ${name}` : ` ${name}="${String(value)}"`))
    .join('');
}

function render(value: unknown): string {
  if (value === null || value === undefined || typeof value === 'boolean') return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(render).join('');
  if (isNode(value)) {
    if (typeof value.type === 'function') return render(value.type(value.props));
    return `<${value.type}${attributes(value.props)}>${render(value.props['children'])}</${value.type}>`;
  }
  if (typeof value === 'function') return render((value as () => unknown)());
  return String(value);
}

// Bun falls back to the CLASSIC React factory for a `.tsx` under `jsx: 'preserve'` — the same
// fallback `@ultimat3/render`'s module loader exists to replace. In an app the loader points it at
// `h`; here this one line does, so the components under test compile to the factory above.
const withFactory = { React: { createElement: h } };

// --- the tests -----------------------------------------------------------------------------

describe('the inert server path', () => {
  const locales = localeConfig();
  const time = timeConfig();

  beforeAll(() => {
    Object.assign(globalThis, withFactory);
  });

  afterEach(() => {
    clearSolidRuntime();
    configureLocales(locales);
    configureTime(time);
  });

  afterAll(() => {
    Reflect.deleteProperty(globalThis, 'React');
  });

  // The premise, made an assertion. Every test below reads the string a component rendered to, and
  // a component whose factory this file does not recognise renders to `"[object Object]"` — 26
  // assertions that pass or fail on the run's file order, silently. Fail here instead, naming it.
  test('the components under test compile to a JSX factory this file understands', () => {
    const node: unknown = (Field as unknown as (props: Record<string, unknown>) => unknown)({
      label: 'Email',
      children: () => null,
    });
    expect(isNode(node)).toBe(true);
  });

  test('Field renders with no Solid runtime registered', () => {
    const html = render(
      h(Field as never, { label: 'Email', required: true, children: () => null }),
    );
    expect(html).toContain('Email');
    expect(html).toContain('<label');
  });

  test('Money and DateTime read the ambient locale and zone rather than a fixed default', () => {
    configureLocales({ fallback: 'fr' as Locale });
    configureTime({ defaultZone: 'Europe/Paris' as TimeZone });

    const money = render(h(Money as never, { value: { minor: 123456, currency: 'EUR' } }));
    // fr-FR groups with a narrow no-break space and puts the symbol last; en-US would be "€1,234.56".
    expect(money).toContain('€');
    expect(money).not.toContain('€1,234.56');

    const when = render(
      h(DateTime as never, { value: '2026-08-15T23:30:00.000Z', dateStyle: 'short' }),
    );
    expect(when).toContain('datetime="2026-08-15T23:30:00.000Z"');
    // 23:30 UTC is already the 16th in Paris — the ambient zone reached the formatter.
    expect(when).toContain('16');
  });

  test('a DOM with no registered runtime still throws, loudly', () => {
    Object.assign(globalThis, { document: {}, window: {} });
    try {
      expect(() => render(h(Field as never, { label: 'Email', children: () => null }))).toThrow(
        expect.objectContaining({ code: UI_ERROR_CODES.runtimeMissing }),
      );
    } finally {
      Reflect.deleteProperty(globalThis, 'document');
      Reflect.deleteProperty(globalThis, 'window');
    }
  });

  // The audit's count, made executable: every component that reaches for a runtime, rendered once
  // through the inert path with the least props it accepts. A single throw here is 23 of ~46
  // components unusable on the surface 23 of 29 tracked routes render on.
  const runtimeDependent: readonly (readonly [string, unknown, Record<string, unknown>])[] = [
    ['AppShell', AppShell, { children: 'body' }],
    ['Breadcrumb', Breadcrumb, { items: [{ label: 'Home', href: '/' }, { label: 'Now' }] }],
    ['Combobox', Combobox, { options: [{ value: 'Paris' }], value: 'Pa' }],
    [
      'DataTable',
      DataTable,
      {
        caption: 'Rows',
        columns: [{ key: 'name', header: 'Name', cell: (row: { name: string }) => row.name }],
        rows: [{ name: 'alpha' }],
        rowKey: (row: { name: string }) => row.name,
      },
    ],
    ['DateTime', DateTime, { value: '2026-08-15T12:00:00.000Z' }],
    ['Dialog', Dialog, { open: true, title: 'Confirm', children: 'body', onClose: () => {} }],
    ['Drawer', Drawer, { open: true, title: 'Filters', children: 'body', onClose: () => {} }],
    ['Dropzone', Dropzone, { label: 'Drop files', onSelect: () => {} }],
    ['EmptyState', EmptyState, {}],
    ['ErrorState', ErrorState, { error: new Error('boom') }],
    ['Field', Field, { label: 'Email', children: () => null }],
    ['FileInput', FileInput, {}],
    ['InfiniteScroll', InfiniteScroll, { children: 'rows', hasMore: true, nextHref: '?page=2' }],
    ['LocaleSwitcher', LocaleSwitcher, { locales: ['en', 'fr'] }],
    [
      'Menu',
      Menu,
      {
        items: [{ id: 'edit', label: 'Edit', onSelect: () => {} }],
        open: true,
        onOpenChange: () => {},
        trigger: () => 'open',
        label: 'Actions',
      },
    ],
    ['Money', Money, { value: { minor: 500, currency: 'USD' } }],
    ['Pagination', Pagination, { page: 2, totalPages: 5 }],
    [
      'Popover',
      Popover,
      {
        open: true,
        onOpenChange: () => {},
        trigger: () => 'open',
        children: 'body',
        label: 'Details',
      },
    ],
    [
      'RelativeTime',
      RelativeTime,
      { value: '2026-08-15T12:00:00.000Z', now: '2026-08-15T13:00:00.000Z' },
    ],
    ['Spinner', Spinner, {}],
    [
      'Tabs',
      Tabs,
      {
        items: [{ id: 'one', label: 'One', panel: 'panel' }],
        value: 'one',
        onChange: () => {},
        label: 'Sections',
      },
    ],
    ['ThemeToggle', ThemeToggle, {}],
    ['Toast', Toast, { children: 'Saved' }],
    ['Toolbar', Toolbar, { children: 'controls', label: 'Filters' }],
  ];

  for (const [name, component, props] of runtimeDependent) {
    test(`${name} renders on the inert path`, () => {
      const html = render(h(component as never, props));
      expect(html.length).toBeGreaterThan(0);
      expect(html.startsWith('<')).toBe(true);
    });
  }

  // The two controls whose current value is NOT an attribute. Asserted on the rendered string
  // because that is the whole bug: `value={…}` typechecks, reads correct, and the parser drops it.
  test('Textarea carries its value as text content, never a value attribute', () => {
    const html = render(h(Textarea as never, { name: 'bio', value: 'hello' }));

    expect(html).not.toContain('value=');
    // The serializer's leading newline, which the parser strips, then the value. Escaping is
    // `@ultimat3/render`'s (`escapeText`), not this file's — the harness here is a 30-line copy.
    expect(html).toContain('>\nhello</textarea>');
  });

  test('Select marks the matching option selected, never a value attribute', () => {
    const html = render(
      h(Select as never, {
        name: 'status',
        value: 'sent',
        options: [
          { value: 'draft', label: 'Draft' },
          { value: 'sent', label: 'Sent' },
        ],
      }),
    );

    expect(/<select[^>]*>/.exec(html)?.[0] ?? '').not.toContain('value=');
    expect(html).toContain('<option value="sent" selected>Sent</option>');
    expect(html).toContain('<option value="draft">Draft</option>');
  });

  test('Select falls back to the placeholder when the value matches no option', () => {
    const html = render(
      h(Select as never, {
        name: 'status',
        value: 'archived',
        placeholder: 'Choose one',
        options: [{ value: 'draft', label: 'Draft' }],
      }),
    );

    expect(html).toContain('<option value="" disabled selected>Choose one</option>');
    expect(html).toContain('<option value="draft">Draft</option>');
  });

  test('UiProvider refuses the inert path instead of dropping the values it was given', () => {
    let caught: unknown;
    try {
      render(h(UiProvider as never, { locale: 'ar' as Locale, children: null }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: UI_ERROR_CODES.runtimeMissing });
    expect((caught as { fix: string }).fix).toContain('useUi()');
  });
});
