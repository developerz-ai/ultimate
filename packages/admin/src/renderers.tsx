// The six renderers a computed column names, and the one dispatch that draws a computed cell. A
// closed set on purpose: each maps a VALUE SHAPE to an `@ultimat3/ui` component, so a column says
// what its value is and never how it is drawn. A seventh shape is a component the app passes.

import { safeUrl } from '@ultimat3/core';
import { t } from '@ultimat3/i18n';
import { Badge, Money, RelativeTime, TONES, type Tone } from '@ultimat3/ui';
import type { JSX } from 'solid-js';
import { jsonText } from './json-text';
import type { AdminRow } from './registry';
import type { AdminComputedColumn, AdminRenderer } from './resource-list';
import { assertMoney, type WidgetContext } from './widget-value';

/** What `truncate` keeps. One line of a laptop-width table cell. */
export const TRUNCATE_AT = 80;

const isTone = (value: unknown): value is Tone => (TONES as readonly unknown[]).includes(value);

const bag = (value: unknown): Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null ? (value as Readonly<Record<string, unknown>>) : {};

const text = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';

const empty = (): JSX.Element => <span>{t('admin.value.empty')}</span>;

type Render = (value: unknown, column: AdminComputedColumn, ctx: WidgetContext) => JSX.Element;

/**
 * | renderer | value |
 * |---|---|
 * | `badge` | text, or `{ label, tone }` |
 * | `relative-time` | a `Date` or an ISO instant |
 * | `money` | `{ minor, currency }` — a float is refused, as everywhere |
 * | `truncate` | text, cut at `TRUNCATE_AT` with the whole value on `title` |
 * | `link` | `{ href, label }` — the href through `safeUrl` |
 * | `json` | anything — keys sorted, a bigint as its digits (`json-text.ts`) |
 */
const RENDERERS: Readonly<Record<AdminRenderer, Render>> = {
  badge: (value) => {
    const tone = bag(value)['tone'];
    const label = typeof value === 'object' ? text(bag(value)['label']) : text(value);
    return label === '' ? empty() : <Badge tone={isTone(tone) ? tone : 'neutral'}>{label}</Badge>;
  },
  'relative-time': (value, _column, ctx) =>
    value instanceof Date || typeof value === 'string' ? (
      <RelativeTime value={value} locale={ctx.locale} timeZone={ctx.timeZone} />
    ) : (
      empty()
    ),
  money: (value, column, ctx) => {
    // The guard names what it refuses; a computed column has no entity field to name.
    const money = assertMoney({ entity: 'columns', name: column.name }, value);
    return money === null ? empty() : <Money value={money} locale={ctx.locale} />;
  },
  truncate: (value) => {
    const whole = text(value);
    if (whole === '') return empty();
    return whole.length <= TRUNCATE_AT ? (
      <span>{whole}</span>
    ) : (
      <span title={whole}>{`${whole.slice(0, TRUNCATE_AT)}…`}</span>
    );
  },
  link: (value) => {
    const href = safeUrl(text(bag(value)['href']), 'href');
    const label = text(bag(value)['label']);
    if (label === '') return empty();
    return href === null ? <span>{label}</span> : <a href={href}>{label}</a>;
  },
  json: (value) =>
    value === undefined ? empty() : <pre class="x-admin-json">{jsonText(value)}</pre>,
};

/** The same table as a Map: a name that is not one of the six draws an empty cell. */
const RENDER: ReadonlyMap<string, Render> = new Map(Object.entries(RENDERERS));

/** One computed cell. */
export function ComputedCell(props: {
  readonly column: AdminComputedColumn;
  readonly row: AdminRow;
  readonly ctx: WidgetContext;
}): JSX.Element {
  const value = props.column.value(props.row);
  const render = props.column.render;
  return typeof render === 'function'
    ? render({ value, row: props.row, ctx: props.ctx })
    : (RENDER.get(render)?.(value, props.column, props.ctx) ?? empty());
}
