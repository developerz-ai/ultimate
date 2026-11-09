// The chart kit's options, asked of the components: a negative, a gap and a zero bar are three
// marks; a rising error rate is never painted good; an unknown gauge reads "no data"; a target is
// a tick; and a live tick keeps a focused point's node — the keyed rule, under a real Solid runtime.

import '../theme/ambient';
import { afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { byTag, nodesOf, one, renderNodes, withAttr } from '@ultimat3/core/render-nodes';
import { FRAMEWORK_CATALOG } from '@ultimat3/i18n';
import { UI_KEYS } from '../i18n-keys';
import { clearSolidRuntime, setSolidRuntime } from '../theme/runtime-slot';
import { BarChart } from './BarChart';
import type { ChartHit } from './ChartFrame';
import { ChartHits } from './ChartFrame';
import { Gauge } from './Gauge';
import { LineChart } from './LineChart';
import { Meter } from './Meter';
import { Sparkline } from './Sparkline';
import { StatTile } from './StatTile';
import { deltaOf } from './stat-delta';

const NONE = FRAMEWORK_CATALOG[UI_KEYS.chartNone] ?? 'no ui.chart.none entry';

describe('BarChart, signed', () => {
  const nodes = () =>
    renderNodes(BarChart, {
      label: 'P&L',
      points: [
        { key: 'mon', value: -5 },
        { key: 'tue', value: null },
        { key: 'wed', value: 0 },
        { key: 'thu', value: 10 },
      ],
    });

  test('a negative hangs below a drawn zero line; a gap is no bar; a zero is a stub', () => {
    const bars = withAttr(nodes(), 'data-bar', 'true');
    expect(bars).toHaveLength(3);
    expect(bars.map((bar) => bar.props['data-sign'])).toEqual(['negative', undefined, undefined]);
    expect(withAttr(nodes(), 'data-zero', 'true')).toHaveLength(1);
    expect(withAttr(nodes(), 'data-axis', 'min')).toHaveLength(1);
  });

  test('the table says a gap is a gap, never an empty cell', () => {
    const cells = byTag(nodes(), 'td').map((cell) => String(cell.props['children']));
    expect(cells).toContain(NONE);
  });

  test('n series over keys refuse a row of the wrong length, naming the series', () => {
    expect(() =>
      renderNodes(BarChart, {
        label: 'x',
        keys: ['a', 'b'],
        series: [{ label: 'short', values: [1] }],
      }),
    ).toThrow(/short/);
  });

  test('a reference widens the range and is drawn and labelled', () => {
    const out = renderNodes(BarChart, {
      label: 'x',
      points: [{ key: 'a', value: 2 }],
      references: [{ value: 10, label: 'Target' }],
    });
    expect(withAttr(out, 'data-reference', 'true')).toHaveLength(1);
    expect(one(withAttr(out, 'data-axis', 'max'), 'max').props['children']).toBe('10');
  });
});

describe('LineChart', () => {
  test('`at` that is not ascending is X_UI_INVALID_VALUE', () => {
    try {
      renderNodes(LineChart, {
        label: 'x',
        keys: ['a', 'b'],
        series: [{ label: 's', values: [1, 2] }],
        at: [5, 5],
      });
      expect.unreachable('a repeated position must be refused');
    } catch (error) {
      expect(error instanceof UltimateError && error.code).toBe('X_UI_INVALID_VALUE');
    }
  });

  test('a toned series carries its tone beside its slot', () => {
    const out = renderNodes(LineChart, {
      label: 'x',
      keys: ['a', 'b'],
      series: [{ label: 'errors', values: [1, 2], tone: 'danger' }],
    });
    const line = one(withAttr(out, 'data-line', '0'), 'the series group');
    expect([line.props['data-series'], line.props['data-tone']]).toEqual([1, 'danger']);
  });
});

describe('Sparkline', () => {
  test('area fills under the line', () => {
    const out = renderNodes(Sparkline, {
      label: 'x',
      area: true,
      points: [
        { key: 'a', value: -1 },
        { key: 'b', value: 1 },
      ],
    });
    expect(withAttr(out, 'data-area', 'true')).toHaveLength(1);
  });
});

describe('StatTile, goodWhen', () => {
  const chip = (props: Record<string, unknown>) =>
    one(
      withAttr(
        renderNodes(StatTile, { label: 'Errors', value: '6%', stat: 'e', ...props }),
        'data-mood',
      ),
      'the chip',
    );

  test('an error rate rising is bad when down is good — no green', () => {
    expect(chip({ delta: deltaOf(120, 100), goodWhen: 'down' }).props['data-mood']).toBe('bad');
    expect(chip({ delta: deltaOf(120, 100) }).props['data-mood']).toBe('good');
    expect(chip({ delta: deltaOf(120, 100), goodWhen: 'none' }).props['data-mood']).toBe('neutral');
  });

  test('a link, a trend and a loading figure', () => {
    const linked = renderNodes(StatTile, { label: 'L', value: '1', stat: 's', href: '/runs' });
    expect(one(byTag(linked, 'a'), 'link').props['href']).toBe('/runs');
    const trend = renderNodes(StatTile, {
      label: 'L',
      value: '1',
      stat: 's',
      trend: [{ key: 'a', value: 1 }],
    });
    expect(withAttr(trend, 'role', 'img')).toHaveLength(1);
    const loading = renderNodes(StatTile, { label: 'L', value: '1', stat: 's', loading: true });
    expect(withAttr(loading, 'data-stat', 's')).toHaveLength(0);
  });
});

describe('Gauge and Meter', () => {
  test('an unknown gauge draws the track alone and reads "no data"', () => {
    const out = renderNodes(Gauge, { label: 'CPU', value: null, max: 100 });
    expect(one(withAttr(out, 'role', 'meter'), 'meter').props['aria-valuetext']).toBe(NONE);
    expect(byTag(out, 'path')).toHaveLength(1);
  });

  test('thresholds pick the tone; a target is a tick', () => {
    const out = renderNodes(Gauge, {
      label: 'CPU',
      value: 95,
      max: 100,
      target: 80,
      thresholds: [
        { at: 70, tone: 'warning' },
        { at: 90, tone: 'danger' },
      ],
    });
    expect(withAttr(out, 'data-tone', 'danger')).toHaveLength(1);
    expect(withAttr(out, 'data-target', 'true')).toHaveLength(1);
    expect(
      withAttr(renderNodes(Meter, { value: 3, max: 4, target: 2 }), 'data-target', 'true'),
    ).toHaveLength(1);
  });

  test('unsorted thresholds are refused', () => {
    expect(() =>
      renderNodes(Gauge, {
        label: 'x',
        value: 1,
        max: 2,
        thresholds: [
          { at: 9, tone: 'danger' },
          { at: 1, tone: 'warning' },
        ],
      }),
    ).toThrow(/thresholds\[1\]/);
  });
});

type Solid = typeof import('solid-js');

describe('keyed hits under a real Solid runtime', () => {
  let solid: Solid;
  beforeAll(async () => {
    const manifest = Bun.resolveSync('solid-js/package.json', import.meta.dir);
    solid = (await import(new URL('dist/solid.js', Bun.pathToFileURL(manifest)).href)) as Solid;
  });
  afterEach(clearSolidRuntime);

  const hit = (id: string, x: string): ChartHit => ({ id, x, y: '50%', label: id, edge: 'middle' });

  test('a tick that shifts the window keeps every surviving point’s node', () => {
    const {
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot,
    } = solid;
    setSolidRuntime({
      createContext,
      useContext,
      createSignal,
      createMemo,
      createEffect,
      onCleanup,
      createRoot,
    });
    const [hits, setHits] = solid.createSignal<readonly ChartHit[]>([
      hit('0:10:00', '0%'),
      hit('0:10:01', '50%'),
      hit('0:10:02', '100%'),
    ]);
    let dispose = (): void => {};
    const output = solid.createRoot((done) => {
      dispose = done;
      return ChartHits({
        get hits() {
          return hits();
        },
      });
    });
    const nodes = () => withAttr(nodesOf(output), 'role', 'img');
    const focused = nodes()[1];
    setHits([hit('0:10:01', '0%'), hit('0:10:02', '50%'), hit('0:10:03', '100%')]);
    // The node the reader was on is the SAME node, now at the window's start — focus stays.
    expect(nodes()[0]).toBe(focused);
    expect(nodes().map((node) => node.props['data-hit'])).toEqual([
      '0:10:01',
      '0:10:02',
      '0:10:03',
    ]);
    dispose();
  });
});
