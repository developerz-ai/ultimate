// The pickers' WIRING, through the props their elements carry: one tab stop in a select-mode grid
// and never on a disabled day, links with no script in link mode, and the native inputs every
// picker is underneath. The rules are tested in `calendar-view`, `date-range-view`, `time-range-url`.

import { describe, expect, test } from 'bun:test';
import { byTag, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import type { PlainDate } from '@ultimat3/time';
import { timeRangeUrl } from '../time-range-url';
import { Calendar } from './Calendar';
import { DatePicker } from './DatePicker';
import { DateRangePicker } from './DateRangePicker';
import { Slider } from './Slider';
import { TimeRangePicker } from './TimeRangePicker';

const stops = (nodes: ReturnType<typeof renderNodes>): unknown[] =>
  byTag(nodes, 'button')
    .filter((node) => node.props['data-date'] !== undefined && node.props['tabIndex'] === 0)
    .map((node) => node.props['data-date']);

describe('Calendar', () => {
  test('select mode is a grid with one tab stop, on the chosen day, and six weeks always', () => {
    const nodes = renderNodes(Calendar, { value: '2026-03-14', onSelect: (): void => {} });
    expect(withAttr(nodes, 'role', 'grid')).toHaveLength(1);
    expect(stops(nodes)).toEqual(['2026-03-14']);
    // One header row, then six weeks.
    expect(byTag(nodes, 'tr')).toHaveLength(7);
    expect(withAttr(nodes, 'aria-selected', 'true')).toHaveLength(1);
  });

  test('a disabled day never lands the roving stop, even when it is the value', () => {
    const nodes = renderNodes(Calendar, {
      value: '2026-03-14',
      isDisabled: (date: PlainDate) => date === '2026-03-14',
      onSelect: (): void => {},
    });
    expect(stops(nodes)).toEqual(['2026-03-01']);
    const disabled = byTag(nodes, 'button').find(
      (node) => node.props['data-date'] === '2026-03-14',
    );
    expect(disabled?.props['disabled']).toBe(true);
  });

  test('link mode is links and no grid role: it works with scripting off', () => {
    const nodes = renderNodes(Calendar, {
      value: '2026-03-14',
      max: '2026-03-20',
      hrefFor: (date: PlainDate) => `/book?day=${date}`,
    });
    expect(withAttr(nodes, 'role', 'grid')).toEqual([]);
    const links = byTag(nodes, 'a');
    expect(links).toHaveLength(20);
    expect(links[0]?.props['href']).toBe('/book?day=2026-03-01');
    expect(withAttr(nodes, 'aria-current', 'date').map((node) => node.props['href'])).toEqual([
      '/book?day=2026-03-14',
    ]);
    // The 21st onward is past max: text, marked disabled, never a link.
    expect(withAttr(nodes, 'aria-disabled', 'true')).toHaveLength(11);
  });

  test('a non-PlainDate value is X_UI_INVALID_VALUE naming the prop', () => {
    expect(() => renderNodes(Calendar, { value: '14/03/2026', onSelect: (): void => {} })).toThrow(
      'Calendar value',
    );
  });
});

describe('date inputs', () => {
  test('DatePicker renders the native input alone on the server: the calendar is an extra', () => {
    const nodes = renderNodes(DatePicker, {
      name: 'day',
      value: '2026-03-14',
      min: '2026-01-01',
    });
    const input = byTag(nodes, 'input')[0];
    expect(input?.props['type']).toBe('date');
    expect([input?.props['name'], input?.props['value'], input?.props['min']]).toEqual([
      'day',
      '2026-03-14',
      '2026-01-01',
    ]);
    expect(byTag(nodes, 'button')).toEqual([]);
  });

  test('DateRangePicker is two named native inputs in one fieldset, posting with no script', () => {
    const nodes = renderNodes(DateRangePicker, {
      legend: 'Created',
      fromName: 'from',
      toName: 'to',
      from: '2026-03-10',
      to: '2026-03-02',
    });
    expect(byTag(nodes, 'fieldset')).toHaveLength(1);
    const inputs = byTag(nodes, 'input');
    expect(inputs.map((node) => [node.props['type'], node.props['name']])).toEqual([
      ['date', 'from'],
      ['date', 'to'],
    ]);
    expect(byTag(nodes, 'button')).toEqual([]);
  });

  test('min after max is refused before anything renders', () => {
    expect(() =>
      renderNodes(DatePicker, { name: 'day', min: '2026-03-10', max: '2026-03-01' }),
    ).toThrow('X_UI_INVALID_VALUE');
  });
});

describe('TimeRangePicker', () => {
  const range = timeRangeUrl('/health?status=up&after=c1&range=week', {
    presets: [
      { id: 'day', label: 'Day', seconds: 86_400 },
      { id: 'week', label: 'Week', seconds: 604_800 },
    ],
    default: 'day',
    timeZone: 'Asia/Tokyo',
    now: new Date('2026-03-01T00:00:00Z'),
  });

  test('presets are links, the custom window a GET form carrying every other parameter', () => {
    const nodes = renderNodes(TimeRangePicker, { range, timeZone: 'Asia/Tokyo', label: 'Window' });
    expect(
      byTag(nodes, 'a').map((node) => [node.props['href'], node.props['aria-current']]),
    ).toEqual([
      ['/health?status=up', undefined],
      ['/health?status=up&range=week', 'true'],
    ]);
    const form = byTag(nodes, 'form')[0];
    expect([form?.props['method'], form?.props['action']]).toEqual(['get', '/health']);
    const inputs = byTag(nodes, 'input').map((node) => [node.props['type'], node.props['name']]);
    expect(inputs).toEqual([
      ['hidden', 'status'],
      ['datetime-local', 'from'],
      ['datetime-local', 'to'],
    ]);
  });

  test('a zone other than the one the window was read in is refused', () => {
    expect(() => renderNodes(TimeRangePicker, { range, timeZone: 'UTC', label: 'Window' })).toThrow(
      'TimeRangePicker timeZone',
    );
  });
});

describe('Slider', () => {
  test('a native range with its label and an output bound to it', () => {
    const nodes = renderNodes(Slider, {
      name: 'volume',
      label: 'Volume',
      id: 'v',
      min: 0,
      max: 10,
      step: 2,
      value: 5,
      format: (value: number) => `${String(value)} dB`,
    });
    const input = byTag(nodes, 'input')[0];
    expect([input?.props['type'], input?.props['value'], input?.props['step']]).toEqual([
      'range',
      6,
      2,
    ]);
    expect(input?.props['aria-valuetext']).toBe('6 dB');
    expect(byTag(nodes, 'output')[0]?.props['for']).toBe('v');
    expect(byTag(nodes, 'label')[0]?.props['for']).toBe('v');
  });
});
