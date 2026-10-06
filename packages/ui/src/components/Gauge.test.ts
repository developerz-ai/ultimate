// The wiring of Gauge — what the markup carries. The dial's maths has its own tests in
// `gauge-view.test.ts`, and the share rule is `meter-view.ts`'s.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { ProbeNode } from '../jsx-probe';
import { byTag, nodesOf, one, probe, renderNodes, unprobe, withAttr } from '../jsx-probe';
import { Gauge } from './Gauge';

const text = (node: ProbeNode | undefined): string =>
  [node?.props['children']]
    .flat()
    .filter((c) => typeof c === 'string')
    .join('');

beforeAll(probe);
afterAll(unprobe);

describe('Gauge', () => {
  test('a meter with its range, its value and the readout as value text', () => {
    const nodes = renderNodes(Gauge, { label: 'CPU', value: 72, max: 100 });
    const meter = one(withAttr(byTag(nodes, 'svg'), 'role', 'meter'), 'meter');
    expect(meter.props['aria-label']).toBe('CPU');
    expect(meter.props['aria-valuemin']).toBe(0);
    expect(meter.props['aria-valuemax']).toBe(100);
    expect(meter.props['aria-valuenow']).toBe(72);
    expect(meter.props['aria-valuetext']).toBe('72%');
    expect(text(one(withAttr(nodes, 'data-readout', 'true'), 'readout'))).toBe('72%');
  });

  test('its label is the visible caption', () => {
    const nodes = renderNodes(Gauge, { label: 'CPU', value: 1, max: 4 });
    const caption = one(byTag(nodes, 'figcaption'), 'caption');
    expect(text(caption)).toBe('CPU');
  });

  test('the caller’s format writes the readout from the value and the max', () => {
    const nodes = renderNodes(Gauge, {
      label: 'Disk',
      value: 7.5,
      max: 10,
      format: (v: number, m: number) => `${v} / ${m} GB`,
    });
    const meter = one(withAttr(byTag(nodes, 'svg'), 'role', 'meter'), 'meter');
    expect(meter.props['aria-valuetext']).toBe('7.5 / 10 GB');
  });

  test('over the max draws a full dial and speaks the max, never "7 of 4"', () => {
    const nodes = renderNodes(Gauge, { label: 'x', value: 7, max: 4 });
    const meter = one(withAttr(byTag(nodes, 'svg'), 'role', 'meter'), 'meter');
    expect(meter.props['aria-valuenow']).toBe(4);
    expect(byTag(nodesOf(meter.props['children']), 'path')).toHaveLength(2);
  });

  test('an empty gauge is its track alone', () => {
    const nodes = renderNodes(Gauge, { label: 'x', value: 0, max: 4 });
    const meter = one(withAttr(byTag(nodes, 'svg'), 'role', 'meter'), 'meter');
    expect(byTag(nodesOf(meter.props['children']), 'path')).toHaveLength(1);
  });

  test('a gauge adds no tab stop: there is one value, and the meter already speaks it', () => {
    expect(withAttr(renderNodes(Gauge, { label: 'x', value: 1, max: 2 }), 'tabindex')).toHaveLength(
      0,
    );
  });
});
