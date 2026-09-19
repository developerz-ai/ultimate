// The wiring of the four small "premium default" components, asked of the components rather than
// of the pure modules beneath them (`stat-delta.ts`, `meter-view.ts` have their own tests): what
// the markup carries, and what a click on the copy control does. `jsx-probe` gives the tree.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  byTag,
  fire,
  one,
  type ProbeNode,
  probe,
  renderNodes,
  unprobe,
  withAttr,
} from '../jsx-probe';
import { CopyButton } from './CopyButton';
import { Kbd } from './Kbd';
import { Meter } from './Meter';
import { StatTile } from './StatTile';

describe('StatTile', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('the figure carries its data-stat hook and the delta chip its trend', () => {
    const nodes = renderNodes(StatTile, {
      label: 'Clicks today',
      value: '1,305',
      stat: 'clicks-today',
      delta: { text: '+12%', trend: 'up' },
      hint: 'vs yesterday',
    });
    const figure = one(withAttr(nodes, 'data-stat', 'clicks-today'), 'the figure');
    expect(figure.props['children']).toBe('1,305');
    expect(byTag(nodes, 'svg')).toHaveLength(1);
    expect(one(byTag(nodes, 'svg'), 'arrow').props['aria-hidden']).toBe('true');
  });

  test('no delta, no chip; no hint, no hint line', () => {
    const nodes = renderNodes(StatTile, { label: 'Total', value: '3', stat: 'total' });
    expect(byTag(nodes, 'svg')).toHaveLength(0);
    expect(byTag(nodes, 'p')).toHaveLength(2);
  });
});

describe('Meter', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('decorative by default: hidden from the tree, no role, the fill width is an attribute', () => {
    const svg = one(byTag(renderNodes(Meter, { value: 25, max: 100 }), 'svg'), 'meter');
    expect(svg.props['aria-hidden']).toBe('true');
    expect(svg.props['role']).toBeUndefined();
    const rects = byTag(renderNodes(Meter, { value: 25, max: 100 }), 'rect');
    expect(rects[1]?.props['width']).toBe('25.0');
  });

  test('with a label it is a meter role that speaks its value', () => {
    const svg = one(
      byTag(renderNodes(Meter, { value: 3, max: 4, label: 'Quota' }), 'svg'),
      'meter',
    );
    expect(svg.props['role']).toBe('meter');
    expect(svg.props['aria-label']).toBe('Quota');
    expect(svg.props['aria-valuenow']).toBe(3);
    expect(svg.props['aria-valuemax']).toBe(4);
    expect(svg.props['aria-hidden']).toBeUndefined();
  });
});

describe('Kbd', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('is a native <kbd>, so it reads as a key with no script', () => {
    const kbd = one(byTag(renderNodes(Kbd, { children: '⌘K' }), 'kbd'), 'kbd');
    expect(kbd.props['children']).toBe('⌘K');
  });
});

describe('CopyButton', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('server-renders a real, labelled button that is not yet in the copied state', () => {
    const button = one(
      byTag(renderNodes(CopyButton, { value: 'https://x.test/abc', label: 'Copy link' }), 'button'),
      'b',
    );
    expect(button.props['type']).toBe('button');
    expect(button.props['aria-label']).toBe('Copy link');
    expect(button.props['data-copied']).toBeUndefined();
    expect(typeof button.props['onClick']).toBe('function');
  });

  test('with no label it falls back to the catalog string, never to an empty name', () => {
    const button = one(byTag(renderNodes(CopyButton, { value: 'x' }), 'button'), 'b');
    expect(typeof button.props['aria-label']).toBe('string');
    expect((button.props['aria-label'] as string).length).toBeGreaterThan(0);
  });

  test('a click writes the value to the clipboard when one exists', async () => {
    const written: string[] = [];
    const nav = globalThis.navigator;
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: {
        clipboard: { writeText: async (text: string): Promise<void> => void written.push(text) },
      },
    });
    try {
      const button = one(byTag(renderNodes(CopyButton, { value: 'copied-value' }), 'button'), 'b');
      fire(button as ProbeNode, 'onClick', {});
      await Promise.resolve();
      expect(written).toEqual(['copied-value']);
    } finally {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: nav });
    }
  });
});
