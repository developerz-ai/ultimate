// The filter bar, control by control: each is named for the URL parameter it sets, prefilled
// from the request, and an active filter no control writes rides the form hidden — submitting
// the bar must narrow the list an operator is looking at, never silently widen it.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import type { AdminField } from './fields';
import { byComponent, byTag, installFactory, nodesOf, restoreFactory } from './inert-jsx';
import type { AdminListRequest } from './list-scope';
import type { AdminResource } from './resource';
import type { WidgetContext } from './widget-value';

await import('@ultimat3/render/server');
const { AdminFilterBar } = await import('./list-filter-bar');

registerCatalog('en', {
  'admin.filter.any': 'Any(probe)',
  'admin.filter.apply': 'Filter(probe)',
  'admin.filter.clear': 'Clear(probe)',
  'admin.filter.find': 'Find(probe)',
  'admin.filter.from': '{field} from(probe)',
  'admin.filter.to': '{field} to(probe)',
  'label.qty': 'Qty',
});

beforeAll(installFactory);
afterAll(restoreFactory);

const field = (over: Partial<AdminField> & Pick<AdminField, 'name'>): AdminField => ({
  entity: 'order',
  type: 'text',
  widget: 'text-input',
  labelKey: `label.${over.name}`,
  required: false,
  readOnly: false,
  sensitive: false,
  inList: true,
  filterable: true,
  sortable: false,
  searchable: false,
  ...over,
});

const FILTERS: readonly AdminField[] = [
  field({ name: 'reference', filterKind: 'text' }),
  field({ name: 'externalId', filterKind: 'exact' }),
  field({ name: 'zone', type: 'timezone', filterKind: 'choice' }),
  field({ name: 'qty', type: 'number', filterKind: 'range' }),
  field({ name: 'dueOn', type: 'date', filterKind: 'range' }),
  field({ name: 'paid', type: 'boolean', filterKind: 'boolean' }),
  field({
    name: 'buyerId',
    type: 'relation',
    filterKind: 'reference',
    relation: { entity: 'buyers' },
  }),
  field({
    name: 'agentId',
    type: 'relation',
    filterKind: 'reference',
    relation: { entity: 'agents' },
  }),
];

const resource = { name: 'order', filters: FILTERS } as unknown as AdminResource;
const ctx: WidgetContext = {
  timeZone: 'UTC',
  locale: 'en',
  optionsFor: () => null,
  // `buyers` is an admin resource this actor may list; `agents` is not one.
  lookupHref: (entity) => (entity === 'buyers' ? '/admin/buyers/lookup' : null),
};

const bar = (request: AdminListRequest = {}, over: Partial<WidgetContext> = {}) =>
  nodesOf(
    AdminFilterBar({
      resource,
      request,
      ctx: { ...ctx, ...over },
      action: '/admin/orders',
      clearHref: '/admin/orders?scope=open',
      returnTo: '/admin/orders?scope=open&f.paid=true',
    }),
  );

/** The CONTROL carrying a parameter — the component, not the `<input>` it renders in turn. */
const named = (nodes: ReturnType<typeof bar>, name: string) =>
  [...byComponent(nodes, 'Input'), ...byComponent(nodes, 'Select')].filter(
    (node) => node.props['name'] === name,
  );

describe('unit · one control per filter shape', () => {
  test('a resource with no filter draws no bar at all', () => {
    const none = { name: 'order', filters: [] } as unknown as AdminResource;
    expect(
      AdminFilterBar({
        resource: none,
        request: {},
        ctx,
        action: '/a',
        clearHref: '/a',
        returnTo: '/a',
      }),
    ).toBeNull();
  });

  test('text is a search box, an exact match a text box, a value-less choice a text box', () => {
    const nodes = bar();
    expect(named(nodes, 'f.reference')[0]?.props['type']).toBe('search');
    expect(named(nodes, 'f.externalId')[0]?.props['type']).toBe('text');
    // A zone column has no list of values to draw a select from.
    expect(named(nodes, 'f.zone')).toHaveLength(1);
    expect(byComponent(nodes, 'Select').some((node) => node.props['name'] === 'f.zone')).toBe(
      false,
    );
  });

  test('a range is from/to under the two operators, typed for its column', () => {
    const nodes = bar({
      filters: [
        { field: 'qty', op: 'gte', value: 2 },
        { field: 'dueOn', op: 'lte', value: '2026-03-01' },
      ],
    });
    const from = named(nodes, 'f.qty.gte')[0];
    expect(from?.props['value']).toBe('2');
    expect(from?.props['inputmode']).toBe('decimal');
    expect(from?.props['aria-label']).toBe('Qty from(probe)');
    expect(named(nodes, 'f.qty.lte')[0]?.props['value']).toBe('');
    const to = named(nodes, 'f.dueOn.lte')[0];
    expect(to?.props['type']).toBe('date');
    expect(to?.props['value']).toBe('2026-03-01');
    // A calendar date has no zone to state.
    expect(to?.props['suffix']).toBeUndefined();
  });

  test('a reference with no option list is an id box — with a lookup link only where one exists', () => {
    const nodes = bar({ filters: [{ field: 'buyerId', op: 'eq', value: 'b_1' }] });
    expect(named(nodes, 'f.buyerId')[0]?.props['value']).toBe('b_1');
    const links = byTag(nodes, 'a')
      .map((node) => String(node.props['href']))
      .filter((href) => href.includes('/lookup'));
    // Back to THIS list, with the parameter the lookup must set.
    expect(links).toEqual([
      '/admin/buyers/lookup?return=%2Fadmin%2Forders%3Fscope%3Dopen%26f.paid%3Dtrue&as=f.buyerId',
    ]);
    expect(named(nodes, 'f.agentId')).toHaveLength(1);
  });

  test('a reference with the target’s rows in hand is a select of them', () => {
    const nodes = bar({}, { optionsFor: () => [{ id: 'b_1', label: 'Acme' }] });
    const select = byComponent(nodes, 'Select').find((node) => node.props['name'] === 'f.buyerId');
    expect(select?.props['options']).toEqual([
      { value: '', label: 'Any(probe)' },
      { value: 'b_1', label: 'Acme' },
    ]);
  });
});

describe('unit · the form carries the whole list state', () => {
  test('scope and sort ride hidden, and so does a filter no control writes', () => {
    const nodes = bar({
      scope: 'open',
      sort: { field: 'qty', direction: 'asc' },
      filters: [
        { field: 'reference', op: 'contains', value: 'A-' },
        { field: 'externalId', op: 'in', value: ['x1', 'x2'] },
        { field: 'qty', op: 'gt', value: 5 },
        { field: 'buyerId', op: 'is-null', value: false },
      ],
    });
    const hidden = byTag(nodes, 'input')
      .filter((node) => node.props['type'] === 'hidden')
      .map((node) => [node.props['name'], node.props['value']]);
    expect(hidden).toEqual([
      ['scope', 'open'],
      ['sort', 'qty:asc'],
      ['f.externalId.in', 'x1'],
      ['f.externalId.in', 'x2'],
      ['f.qty.gt', '5'],
      ['f.buyerId.is-null', 'false'],
    ]);
    // The one a control DOES write is in its control, not hidden twice.
    expect(named(nodes, 'f.reference')[0]?.props['value']).toBe('A-');
  });

  test('Clear is offered only while a filter is active, and it is a link', () => {
    expect(byComponent(bar(), 'Link')).toHaveLength(0);
    const active = bar({ filters: [{ field: 'paid', op: 'eq', value: true }] });
    expect(byComponent(active, 'Link')[0]?.props['href']).toBe('/admin/orders?scope=open');
    expect(named(active, 'f.paid')[0]?.props['value']).toBe('true');
  });

  test('it is a GET form at the list’s own URL, inside a search landmark', () => {
    const nodes = bar();
    const form = byTag(nodes, 'form')[0];
    expect(form?.props['method']).toBe('get');
    expect(form?.props['action']).toBe('/admin/orders');
    expect(byTag(nodes, 'search')).toHaveLength(1);
    expect(form?.props['onSubmit']).toBeUndefined();
  });
});
