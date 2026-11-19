// A calendar pick, with native inputs that deliver the `change` the grid dispatches back into the
// component's own handler — as a browser does. `pickers-wiring.test.ts`' inputs only record it,
// which is how a range nobody chose reached `onChange` unseen.

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
} from '@ultimat3/core/render-nodes';
import { plainDate } from '@ultimat3/time';
import { fakeMatchMedia, installGlobals, syncRuntime } from '../browser-fake-fixture';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { DateRangePicker } from './DateRangePicker';
import { FINE_POINTER_QUERY } from './date-picker-view';
import { type DateRange, pickRange } from './date-range-view';

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
  clearSolidRuntime();
});

/** A native input whose dispatched `change` runs the rendered node's `onChange`, on itself. */
const liveInput = (node: RenderNode, value: string) => {
  const input = {
    value,
    dispatchEvent: (event: Event): boolean => {
      if (event.type === 'change') fire(node, 'onChange', { currentTarget: input });
      return true;
    },
  };
  attachRef(node, input);
  return input;
};

const mount = (from: string, to: string) => {
  restore = installGlobals({ matchMedia: fakeMatchMedia(new Map([[FINE_POINTER_QUERY, true]])) });
  const rt = syncRuntime();
  setSolidRuntime(rt.runtime);
  const seen: unknown[] = [];
  const nodes = renderNodes(
    DateRangePicker,
    {
      legend: 'Stay',
      fromName: 'from',
      toName: 'to',
      from,
      to,
      onChange: (range: unknown) => seen.push(range),
    },
    { components: 'keep' },
  );
  const [fromNode, toNode] = byTag(nodes, 'input');
  if (fromNode === undefined || toNode === undefined) return expect.unreachable('two inputs');
  const inputs = { from: liveInput(fromNode, from), to: liveInput(toNode, to) };
  const popover = one(byComponent(nodes, 'Popover'), '<Popover>');
  const calendar = one(
    byComponent(nodesOf(popover.props['children'], { components: 'keep' }), 'Calendar'),
    '<Calendar>',
  );
  const pick = calendar.props['onSelect'] as (date: string) => void;
  return { seen, inputs, pick, fromNode, open: rt.signals[1] };
};

describe('DateRangePicker, a calendar pick over a held range', () => {
  test('a calendar pick calls onChange once, with the range pickRange answered', () => {
    const held: DateRange = { from: plainDate('2026-03-10'), to: plainDate('2026-03-20') };
    const { seen, inputs, pick } = mount('2026-03-10', '2026-03-20');

    // A new start: never the old `to` paired with it (Mar 20 – Mar 25 is a range nobody chose).
    pick('2026-03-25');
    const first = pickRange(held, plainDate('2026-03-25')).range;
    expect(first).toEqual({ from: plainDate('2026-03-25'), to: undefined });
    expect(seen).toEqual([first]);
    expect([inputs.from.value, inputs.to.value]).toEqual(['2026-03-25', '']);

    // The completing pick: once, in order.
    pick('2026-03-22');
    expect(seen).toEqual([first, { from: '2026-03-22', to: '2026-03-25' }]);
    expect([inputs.from.value, inputs.to.value]).toEqual(['2026-03-22', '2026-03-25']);
  });

  test('a typed end after a pick still commits: the pick does not leave the handler deaf', () => {
    const { seen, inputs, pick, fromNode } = mount('2026-03-10', '2026-03-20');
    pick('2026-03-25');
    inputs.from.value = '2026-03-01';
    fire(fromNode, 'onChange', { currentTarget: inputs.from });
    expect(seen.at(-1)).toEqual({ from: '2026-03-01', to: undefined });
    expect(seen).toHaveLength(2);
  });
});
