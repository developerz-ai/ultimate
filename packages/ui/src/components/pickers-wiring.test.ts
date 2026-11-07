// The pickers' island halves under a runtime whose effects run: a calendar popover only for a fine
// pointer, F4 / Alt+ArrowDown opening it, a picked day written into the NATIVE input (the value
// the form posts) the way typing would, a range closing on its second end, and the calendar's own
// month buttons, arrow keys and month links. `pickers.test.ts` holds the server render.

import '../theme/ambient';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  attachRef,
  byComponent,
  byTag,
  fire,
  nodesOf,
  one,
  type RenderNode,
  renderNodes,
  withAttr,
} from '@ultimat3/core/render-nodes';
import type { PlainDate } from '@ultimat3/time';
import { fakeMatchMedia, installGlobals, syncRuntime } from '../browser-fake-fixture';
import { FakeElement } from '../fake-dom-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { Calendar } from './Calendar';
import { DatePicker } from './DatePicker';
import { DateRangePicker } from './DateRangePicker';
import { FINE_POINTER_QUERY } from './date-picker-view';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  clearSolidRuntime();
});

const mount = (component: unknown, props: Record<string, unknown>, fine = true) => {
  restore = installGlobals({ matchMedia: fakeMatchMedia(new Map([[FINE_POINTER_QUERY, fine]])) });
  const rt = syncRuntime();
  setSolidRuntime(rt.runtime);
  const nodes = renderNodes(component, props, { components: 'keep' });
  return { nodes, signals: rt.signals };
};

/** The native input the grid writes into: its value, and the events a typed value would fire. */
const nativeInput = (value = '') => {
  const fired: string[] = [];
  return { value, fired, dispatchEvent: (event: Event) => fired.push(event.type) > 0 };
};

const key = (k: string, altKey = false) => {
  const event = {
    key: k,
    altKey,
    prevented: false,
    preventDefault(): void {
      event.prevented = true;
    },
  };
  return event;
};

/** The popover draws its content only once open; the Calendar is the child it was handed. */
const calendarOf = (nodes: readonly RenderNode[]): RenderNode => {
  const popover = one(byComponent(nodes, 'Popover'), '<Popover>');
  return one(
    byComponent(nodesOf(popover.props['children'], { components: 'keep' }), 'Calendar'),
    '<Calendar>',
  );
};

describe('DatePicker', () => {
  test('a coarse pointer keeps the native picker alone: no popover, and F4 is the browser’s', () => {
    const { nodes } = mount(DatePicker, { name: 'day' }, false);
    expect(byComponent(nodes, 'Popover')).toHaveLength(0);
    const f4 = key('F4');
    fire(one(byTag(nodes, 'input'), '<input>'), 'onKeyDown', f4);
    expect(f4.prevented).toBe(false);
  });

  test('a fine pointer gets the popover; F4 and Alt+ArrowDown open it, another key does not', () => {
    const { nodes, signals } = mount(DatePicker, { name: 'day', value: '2026-03-14' });
    // DatePicker's signals, in order: enhanced, open, current.
    const open = signals[1];
    expect(byComponent(nodes, 'Popover')).toHaveLength(1);
    const input = one(byTag(nodes, 'input'), '<input>');
    const plain = key('ArrowDown');
    fire(input, 'onKeyDown', plain);
    expect([plain.prevented, open?.()]).toEqual([false, false]);
    const f4 = key('F4');
    fire(input, 'onKeyDown', f4);
    expect([f4.prevented, open?.()]).toEqual([true, true]);
    fire(input, 'onKeyDown', key('ArrowDown', true));
    expect(open?.()).toBe(true);
  });

  test('the trigger toggles it; a picked day is written into the native input and closes it', () => {
    const { nodes, signals } = mount(DatePicker, { name: 'day', value: '2026-03-14' });
    const [, open, current] = signals;
    const popover = one(byComponent(nodes, 'Popover'), '<Popover>');
    const trigger = (popover.props['trigger'] as (control: Record<string, unknown>) => unknown)({
      id: 't',
      'aria-expanded': false,
      'aria-controls': 'p',
    });
    const button = one(byTag(nodesOf(trigger), 'button'), 'trigger');
    fire(button, 'onClick', {});
    expect(open?.()).toBe(true);
    const input = nativeInput('2026-03-14');
    attachRef(one(byTag(nodes, 'input'), '<input>'), input);
    (calendarOf(nodes).props['onSelect'] as (date: string) => void)('2026-03-20');
    expect(input.value).toBe('2026-03-20');
    expect(input.fired).toEqual(['input', 'change']);
    expect(current?.()).toBe('2026-03-20');
    expect(open?.()).toBe(false);
  });

  test('a typed change reaches onChange as a date, and a half-typed one as undefined', () => {
    const seen: unknown[] = [];
    const { nodes } = mount(DatePicker, { name: 'day', onChange: (d: unknown) => seen.push(d) });
    const input = one(byTag(nodes, 'input'), '<input>');
    fire(input, 'onChange', { currentTarget: { value: '2026-04-01' } });
    fire(input, 'onChange', { currentTarget: { value: '' } });
    expect(seen).toEqual(['2026-04-01', undefined]);
  });
});

describe('DateRangePicker', () => {
  const props = (seen: unknown[]) => ({
    legend: 'Stay',
    fromName: 'from',
    toName: 'to',
    month: '2026-03-01',
    onChange: (range: unknown) => seen.push(range),
  });

  test('the first pick sets from and clears to; the second sets to, in order, and closes', () => {
    const seen: unknown[] = [];
    const { nodes, signals } = mount(DateRangePicker, props(seen));
    const open = signals[1];
    const [fromNode, toNode] = byTag(nodes, 'input');
    if (fromNode === undefined || toNode === undefined) return expect.unreachable('two inputs');
    const from = nativeInput();
    const to = nativeInput('2026-02-02');
    attachRef(fromNode, from);
    attachRef(toNode, to);
    fire(fromNode, 'onKeyDown', key('F4'));
    expect(open?.()).toBe(true);
    const pick = calendarOf(nodes).props['onSelect'] as (date: string) => void;
    pick('2026-03-10');
    expect([from.value, to.value]).toEqual(['2026-03-10', '']);
    expect(open?.()).toBe(true);
    pick('2026-03-05');
    expect([from.value, to.value]).toEqual(['2026-03-05', '2026-03-10']);
    expect(to.fired).toEqual(['input', 'change']);
    expect(open?.()).toBe(false);
    expect(seen.at(-1)).toEqual({ from: '2026-03-05', to: '2026-03-10' });
  });

  test('typing either end commits the range in order; the trigger toggles the popover', () => {
    const seen: unknown[] = [];
    const { nodes, signals } = mount(DateRangePicker, props(seen));
    const [fromNode, toNode] = byTag(nodes, 'input');
    if (fromNode === undefined || toNode === undefined) return expect.unreachable('two inputs');
    fire(fromNode, 'onChange', { currentTarget: { value: '2026-03-09' } });
    fire(toNode, 'onChange', { currentTarget: { value: '2026-03-02' } });
    expect(seen).toEqual([
      { from: '2026-03-09', to: undefined },
      { from: '2026-03-02', to: '2026-03-09' },
    ]);
    const popover = one(byComponent(nodes, 'Popover'), '<Popover>');
    const trigger = (popover.props['trigger'] as (control: Record<string, unknown>) => unknown)({
      id: 't',
    });
    fire(one(byTag(nodesOf(trigger), 'button'), 'trigger'), 'onClick', {});
    expect(signals[1]?.()).toBe(true);
  });

  test('a coarse pointer: no popover, and F4 stays the browser’s', () => {
    const { nodes } = mount(DateRangePicker, props([]), false);
    expect(byComponent(nodes, 'Popover')).toHaveLength(0);
    const f4 = key('F4');
    fire(one(byTag(nodes, 'input').slice(0, 1), 'from'), 'onKeyDown', f4);
    expect(f4.prevented).toBe(false);
  });
});

describe('Calendar, select mode', () => {
  const mountCalendar = (extra: Record<string, unknown> = {}) => {
    const rt = syncRuntime();
    setSolidRuntime(rt.runtime);
    const picked: string[] = [];
    const nodes = renderNodes(Calendar, {
      value: '2026-03-14',
      onSelect: (date: string) => picked.push(date),
      ...extra,
    });
    // Calendar's signals, in order: month, focused.
    return { nodes, picked, month: rt.signals[0], focused: rt.signals[1] };
  };

  test('the month buttons step the month; a day click selects it and takes focus', () => {
    const c = mountCalendar();
    const [previous, next] = byTag(c.nodes, 'button').filter(
      (b) => b.props['data-date'] === undefined,
    );
    if (previous === undefined || next === undefined)
      return expect.unreachable('two month buttons');
    fire(next, 'onClick', {});
    expect(c.month?.()).toBe('2026-04-01');
    fire(previous, 'onClick', {});
    fire(previous, 'onClick', {});
    expect(c.month?.()).toBe('2026-02-01');
    fire(one(withAttr(c.nodes, 'data-date', '2026-03-20'), 'day 20'), 'onClick', {});
    expect(c.picked).toEqual(['2026-03-20']);
    expect(c.focused?.()).toBe('2026-03-20');
  });

  test('an arrow key moves focus to that day’s button; across a month edge the month follows', () => {
    const c = mountCalendar();
    const table = new FakeElement('table');
    const day = (date: string) => {
      const button = new FakeElement('button');
      Object.assign(button, { dataset: { date } });
      return button;
    };
    const target = day('2026-03-15');
    table.append(day('2026-03-14'), target);
    attachRef(one(byTag(c.nodes, 'table'), '<table>'), table);
    const grid = one(byTag(c.nodes, 'table'), '<table>');
    const right = {
      key: 'ArrowRight',
      shiftKey: false,
      target: { dataset: { date: '2026-03-14' } },
      preventDefault: () => {},
    };
    fire(grid, 'onKeyDown', right);
    expect(target.focusCount).toBe(1);
    expect(c.focused?.()).toBe('2026-03-15');
    fire(grid, 'onKeyDown', { ...right, key: 'PageDown' });
    expect(c.month?.()).toBe('2026-04-01');
    const stray = { ...right, key: 'q' };
    fire(grid, 'onKeyDown', stray);
    fire(grid, 'onKeyDown', { ...right, target: { dataset: {} } });
    expect(c.focused?.()).toBe('2026-04-14');
  });
});

describe('Calendar, link mode', () => {
  test('month links only when the caller gave months a URL', () => {
    const withMonths = renderNodes(Calendar, {
      value: '2026-03-14',
      hrefFor: (date: PlainDate) => `/d/${date}`,
      monthHrefFor: (month: PlainDate) => `/m/${month}`,
    });
    const months = byTag(withMonths, 'a').filter((a) => String(a.props['href']).startsWith('/m/'));
    expect(months.map((a) => a.props['href'])).toEqual(['/m/2026-02-01', '/m/2026-04-01']);
    const without = renderNodes(Calendar, { value: '2026-03-14', hrefFor: (d: PlainDate) => d });
    // March's 31 days, and not one month control.
    expect(byTag(without, 'a')).toHaveLength(31);
    expect(byTag(withMonths, 'a')).toHaveLength(33);
  });
});
