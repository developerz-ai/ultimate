// The wiring of QrCode — what the markup carries; the encoder has its own tests in
// `qr-encode.test.ts`.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { byTag, one, probe, renderNodes, unprobe } from '../jsx-probe';
import { QrCode } from './QrCode';
import { encodeQr } from './qr-matrix';

describe('QrCode', () => {
  beforeAll(probe);
  afterAll(unprobe);

  test('is an image with a name, a viewBox of size plus the quiet zone, one rect per dark module', () => {
    const nodes = renderNodes(QrCode, {
      value: 'HELLO WORLD',
      label: 'Open this page on your phone',
    });
    const svg = one(byTag(nodes, 'svg'), 'qr');
    expect(svg.props['role']).toBe('img');
    expect(svg.props['aria-label']).toBe('Open this page on your phone');
    expect(svg.props['shape-rendering']).toBe('crispEdges');
    // Version 1 is 21 modules; 4 light modules on every side makes 29.
    expect(svg.props['viewBox']).toBe('0 0 29 29');
    const dark = encodeQr('HELLO WORLD').modules.flat().filter(Boolean).length;
    // The ground plus one rect per dark module — a light module draws nothing.
    expect(byTag(nodes, 'rect')).toHaveLength(dark + 1);
  });

  test('the quiet zone is a prop, and the modules move with it', () => {
    const nodes = renderNodes(QrCode, { value: 'HELLO WORLD', label: 'x', quietZone: 1 });
    expect(one(byTag(nodes, 'svg'), 'qr').props['viewBox']).toBe('0 0 23 23');
    const modules = byTag(nodes, 'rect').slice(1);
    expect(modules.every((rect) => (rect.props['x'] as number) >= 1)).toBe(true);
    // Row 0, column 0 is a finder-pattern corner and always dark.
    expect(modules[0]?.props['x']).toBe(1);
    expect(modules[0]?.props['y']).toBe(1);
  });
});
