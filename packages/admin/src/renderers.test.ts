// The six renderers a computed column names. Each maps a VALUE SHAPE to a cell; a value that is
// not that shape is an empty cell — never a thrown render, except money, where a float is a bug.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { registerCatalog } from '@ultimat3/i18n';
import {
  byComponent,
  byTag,
  installFactory,
  nodesOf,
  one,
  renderHtml,
  restoreFactory,
} from './inert-jsx-fixture';
import { computedRow } from './registry';
import type { AdminComputedColumn, AdminRenderer } from './resource-list';
import type { WidgetContext } from './widget-value';

await import('@ultimat3/render/server');
const { ComputedCell, TRUNCATE_AT } = await import('./renderers');

registerCatalog('en', { 'admin.value.empty': 'EMPTY(probe)' });

beforeAll(installFactory);
afterAll(restoreFactory);

const ctx: WidgetContext = { timeZone: 'Europe/Madrid', locale: 'en-GB' };

const cell = (render: AdminRenderer, value: unknown): unknown =>
  ComputedCell({
    column: { name: 'probe', labelKey: 'probe', value: () => value, render } as AdminComputedColumn,
    row: {},
    ctx,
  });

const html = (render: AdminRenderer, value: unknown): string => renderHtml(cell(render, value));

describe('unit · the closed renderer set', () => {
  test('badge: text, or a label with a tone — and a tone that is not one is neutral', () => {
    const toned = one(
      byComponent(nodesOf(cell('badge', { label: 'Paid', tone: 'success' })), 'Badge'),
      '<Badge>',
    );
    expect(toned.props['tone']).toBe('success');
    expect(toned.props['children']).toBe('Paid');
    const plain = one(byComponent(nodesOf(cell('badge', 'draft')), 'Badge'), '<Badge>');
    expect(plain.props['tone']).toBe('neutral');
    expect(
      one(byComponent(nodesOf(cell('badge', { label: 'x', tone: 'purple' })), 'Badge'), '<Badge>')
        .props['tone'],
    ).toBe('neutral');
    expect(html('badge', null)).toContain('EMPTY(probe)');
  });

  test('relative-time: a Date or an ISO instant, in the actor’s zone and locale', () => {
    const node = one(
      byComponent(nodesOf(cell('relative-time', '2026-01-01T00:00:00.000Z')), 'RelativeTime'),
      '<RelativeTime>',
    );
    expect(node.props['timeZone']).toBe('Europe/Madrid');
    expect(node.props['locale']).toBe('en-GB');
    expect(byComponent(nodesOf(cell('relative-time', new Date(0))), 'RelativeTime')).toHaveLength(
      1,
    );
    expect(html('relative-time', 42)).toContain('EMPTY(probe)');
  });

  test('money: integer minor units and a currency; a float is refused, as everywhere', () => {
    const node = one(
      byComponent(nodesOf(cell('money', { minor: 1250, currency: 'EUR' })), 'Money'),
      '<Money>',
    );
    expect(node.props['value']).toEqual({ minor: 1250, currency: 'EUR' });
    expect(html('money', null)).toContain('EMPTY(probe)');
    expect(() => cell('money', 12.5)).toThrow(/columns\.probe: money value arrived as the number/);
  });

  test('truncate: cut at the limit, with the whole value on `title`', () => {
    expect(html('truncate', 'short')).toBe('<span>short</span>');
    const long = 'x'.repeat(TRUNCATE_AT + 5);
    const cut = one(byTag(nodesOf(cell('truncate', long)), 'span'), '<span>');
    expect(cut.props['title']).toBe(long);
    expect(cut.props['children']).toBe(`${'x'.repeat(TRUNCATE_AT)}…`);
    expect(html('truncate', 7)).toBe('<span>7</span>');
    expect(html('truncate', {})).toContain('EMPTY(probe)');
  });

  test('link: an href through safeUrl — a javascript: URL is text, never an anchor', () => {
    expect(html('link', { href: '/orders/7', label: 'Order 7' })).toBe(
      '<a href="/orders/7">Order 7</a>',
    );
    const unsafe = html('link', { href: 'javascript:alert(1)', label: 'Click' });
    expect(unsafe).toBe('<span>Click</span>');
    expect(html('link', { href: '/x' })).toContain('EMPTY(probe)');
  });

  test('json: keys sorted, and a bigint as the NUMBER an operator reads', () => {
    // `JSON.stringify` raises on a bigint and core's `canonicalJson` spells it `BigInt(2)` — a
    // hash form. The cell shows the digits.
    expect(html('json', { b: 1, a: 2n })).toContain('{"a":2,"b":1}');
    expect(html('json', undefined)).toContain('EMPTY(probe)');
  });

  test('a component for the seventh: it is handed the value, the row and the context', () => {
    const seen: unknown[] = [];
    const out = ComputedCell({
      column: {
        name: 'probe',
        labelKey: 'probe',
        value: (row) => row['n'],
        render: (props) => {
          seen.push(props);
          return `#${String(props.value)}`;
        },
      },
      row: { n: 3 },
      ctx,
    });
    expect(out).toBe('#3');
    expect(seen).toEqual([{ value: 3, row: { n: 3 }, ctx }]);
  });
});

describe('unit · the row a computed column reads', () => {
  test('carries no sealed column, whether or not the repo hid it', () => {
    expect(computedRow({ id: 1, title: 'a', apiKey: 'CANARY' }, ['apiKey'])).toEqual({
      id: 1,
      title: 'a',
    });
    expect(computedRow({ id: 1 }, [])).toEqual({ id: 1 });
  });
});
