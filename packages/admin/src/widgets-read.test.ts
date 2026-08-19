// Read mode: what the detail row and the list cell actually put on screen. Driven through the
// inert factory (`inert-jsx.ts`), the same server path `@ultimat3/render` has — a view is a plain
// function of props here, exactly as `renderToHtml` calls it.
//
// The assertions are on the PROPS the admin handed a design-system component, not on the markup
// ui chose to emit for them: `<Money value={…}>` is this package's contract, `<span class="money">`
// is ui's and changes without this package changing.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminField } from './fields';
import {
  byComponent,
  byTag,
  installFactory,
  isInertNode,
  nodesOf,
  one,
  renderHtml,
  restoreFactory,
} from './inert-jsx';
import type { WidgetContext } from './widget-value';
import { formatCalendarDate, Widget } from './widgets';

// Distinctive probe strings, so an assertion names the KEY the view asked for rather than the
// English the framework catalog happens to ship. `registry-snapshot.ts` restores every catalog at
// this file's boundary, so nothing here reaches a neighbouring suite.
registerCatalog('en', {
  'admin.value.empty': 'EMPTY(probe)',
  'admin.value.true': 'YES(probe)',
  'admin.value.false': 'NO(probe)',
});

beforeAll(installFactory);
afterAll(restoreFactory);

const field = (over: Partial<AdminField>): AdminField => ({
  entity: 'invoice',
  name: 'total',
  type: 'money',
  widget: 'money',
  labelKey: 'admin.invoice.field.total',
  required: true,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: false,
  sortable: true,
  searchable: false,
  ...over,
});

const ctx: WidgetContext = { timeZone: 'Europe/Madrid', locale: 'es-ES' };

const read = (f: Partial<AdminField>, value: unknown, over: Partial<WidgetContext> = {}): unknown =>
  Widget({ field: field(f), value, ctx: { ...ctx, ...over }, mode: 'read' });

const html = (f: Partial<AdminField>, value: unknown, over: Partial<WidgetContext> = {}): string =>
  renderHtml(read(f, value, over));

describe('the premise: these views compile to a factory this file understands', () => {
  // Every assertion below reads a tree. A component whose factory this walker does not recognise
  // walks to `[]` and serialises to `"[object Object]"` — 30 assertions that pass or fail on the
  // run's file order, silently. Fail here instead, naming it.
  test('a widget returns a node, not an opaque object', () => {
    expect(isInertNode(read({}, { minor: 1, currency: 'EUR' }))).toBe(true);
  });
});

describe('an absent value renders the empty marker, never a blank cell', () => {
  const EMPTY_CASES: readonly (readonly [string, Partial<AdminField>])[] = [
    ['money', { widget: 'money', type: 'money' }],
    ['datetime', { widget: 'datetime', type: 'timestamptz' }],
    ['select', { widget: 'select', type: 'enum', values: ['draft'] }],
    ['reference', { widget: 'reference', type: 'relation' }],
    ['upload', { widget: 'upload', type: 'file' }],
  ];

  for (const [name, over] of EMPTY_CASES) {
    test(`${name} renders admin.value.empty`, () => {
      expect(html(over, null)).toContain('EMPTY(probe)');
    });
  }
});

describe('money', () => {
  test('the row value reaches <Money> whole — minor units and currency together', () => {
    const nodes = nodesOf(read({}, { minor: 1999, currency: 'EUR' }));
    const money = one(byComponent(nodes, 'Money'), '<Money>');
    expect(money.props['value']).toEqual({ minor: 1999, currency: 'EUR' });
  });

  test('a float minor is refused here rather than rendered as a wrong amount', () => {
    expect(() => read({}, { minor: 19.99, currency: 'EUR' })).toThrow(
      expect.objectContaining({ code: 'X_ADMIN_FIELD_UNSUPPORTED' }),
    );
  });
});

describe('datetime', () => {
  test('an instant carries the actor zone and ui default formatting', () => {
    const nodes = nodesOf(
      read({ widget: 'datetime', type: 'timestamptz' }, '2026-08-18T23:30:00.000Z'),
    );
    const when = one(byComponent(nodes, 'DateTime'), '<DateTime>');
    expect(when.props['value']).toBe('2026-08-18T23:30:00.000Z');
    expect(when.props['timeZone']).toBe('Europe/Madrid');
    // An instant genuinely HAS a zone, so it must not be pinned to the calendar formatter.
    expect(when.props['format']).toBeUndefined();
  });

  test('a calendar date is formatted by the zone-independent formatter, not the ambient one', () => {
    const nodes = nodesOf(read({ widget: 'datetime', type: 'date' }, '2026-08-18'));
    const when = one(byComponent(nodes, 'DateTime'), '<DateTime>');
    expect(when.props['format']).toBe(formatCalendarDate);
  });

  test('no zone in the context is refused before anything is formatted', () => {
    expect(() =>
      read({ widget: 'datetime', type: 'timestamptz' }, '2026-08-18T00:00:00.000Z', {
        timeZone: '',
      }),
    ).toThrow(expect.objectContaining({ code: 'X_ADMIN_FIELD_UNSUPPORTED' }));
  });
});

describe('checkbox', () => {
  test('true and false read as words, not as an unticked box the operator cannot tell from empty', () => {
    const on = html({ widget: 'checkbox', type: 'boolean' }, true);
    const off = html({ widget: 'checkbox', type: 'boolean' }, false);
    expect(on).toContain('YES(probe)');
    expect(off).toContain('NO(probe)');
    expect(on).not.toContain('NO(probe)');
  });
});

describe('select', () => {
  test('the option label is keyed under the FIELD, so two enums never share a translation', () => {
    const out = html({ widget: 'select', type: 'enum', values: ['draft', 'live'] }, 'live');
    expect(out).toContain('admin.invoice.field.total.option.live');
    expect(out).not.toContain('option.draft');
  });

  test('an overridden labelKey is the namespace the read view asks under', () => {
    const out = html(
      { widget: 'select', type: 'enum', labelKey: 'shop.state', values: ['live'] },
      'live',
    );
    expect(out).toContain('shop.state.option.live');
  });
});

describe('json', () => {
  test('a json value is pretty-printed inside the admin json block', () => {
    const out = html({ widget: 'json-editor', type: 'json' }, { a: [1, 2] });
    expect(out).toContain('class="x-admin-json"');
    expect(out).toContain('<pre');
    expect(out).toContain('"a"');
  });
});

describe('reference', () => {
  const relation = { widget: 'reference', type: 'relation', relation: { entity: 'customer' } };

  test('with a route table it links through hrefFor, with the id as the text', () => {
    const nodes = nodesOf(
      read(relation as Partial<AdminField>, 'c_9', {
        hrefFor: (entity, id) => `/back-office/${entity}/${id}`,
      }),
    );
    const link = one(byTag(nodes, 'a'), '<a>');
    // `/customers/c_9` — pluralisation by concatenation, and it drops basePath. The route table
    // belongs to AdminApp; a widget three layers down does not get to guess it.
    expect(link.props['href']).toBe('/back-office/customer/c_9');
    expect(link.props['children']).toBe('c_9');
  });

  test('the entity name handed to hrefFor is the RELATION target, not the column', () => {
    const seen: string[] = [];
    read({ ...relation, name: 'customerId' } as Partial<AdminField>, 'c_9', {
      hrefFor: (entity) => {
        seen.push(entity);
        return null;
      },
    });
    expect(seen).toEqual(['customer']);
  });

  test('without a route table it is plain text — a wrong link is worse than no link', () => {
    const nodes = nodesOf(read(relation as Partial<AdminField>, 'c_9'));
    expect(byTag(nodes, 'a')).toHaveLength(0);
    expect(renderHtml(read(relation as Partial<AdminField>, 'c_9'))).toContain('c_9');
  });

  test('an hrefFor that answers null for this row also renders plain text', () => {
    const nodes = nodesOf(read(relation as Partial<AdminField>, 'c_9', { hrefFor: () => null }));
    expect(byTag(nodes, 'a')).toHaveLength(0);
  });
});

describe('upload', () => {
  test('a stored file renders its name behind its url', () => {
    const nodes = nodesOf(
      read({ widget: 'upload', type: 'file' }, { url: 'https://cdn.test/a.pdf', name: 'a.pdf' }),
    );
    const link = one(byTag(nodes, 'a'), '<a>');
    expect(link.props['href']).toBe('https://cdn.test/a.pdf');
    expect(link.props['children']).toBe('a.pdf');
  });

  test('a javascript: url is dropped rather than rendered as an href', () => {
    const nodes = nodesOf(
      // eslint-disable-next-line no-script-url -- the value under test
      read({ widget: 'upload', type: 'file' }, { url: 'javascript:alert(1)', name: 'evil' }),
    );
    const link = one(byTag(nodes, 'a'), '<a>');
    expect(link.props['href']).toBeUndefined();
    // The name still renders: the row is visible, the scheme is not clickable.
    expect(link.props['children']).toBe('evil');
  });
});

describe('the default branch', () => {
  test('a plain text value renders as itself', () => {
    expect(html({ widget: 'text-input', type: 'text', name: 'title' }, 'Hello')).toBe(
      '<span>Hello</span>',
    );
  });

  test('a number renders its digits rather than the empty marker', () => {
    expect(html({ widget: 'number-input', type: 'number', name: 'qty' }, 0)).toBe('<span>0</span>');
  });
});
