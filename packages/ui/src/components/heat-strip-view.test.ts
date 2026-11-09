// A HeatStrip cell is named by its whole reading, shaped by its tone, and unique in its row.

import { describe, expect, test } from 'bun:test';
import { HEAT_SHAPES, heatCells } from './heat-strip-view';

describe('heatCells', () => {
  const row = {
    label: 'api',
    cells: [
      { key: '12:00', label: '12:00 — all passed', tone: 'success' as const },
      { key: '12:05', label: '12:05 — 3 failed', tone: 'danger' as const, href: '/runs/7' },
      { key: '12:10', label: '12:10 — no data' },
    ],
  };

  test('each cell is named by its row and its full reading — never by its colour', () => {
    expect(heatCells(row).map((cell) => cell.name)).toEqual([
      'api, 12:00 — all passed',
      'api, 12:05 — 3 failed',
      'api, 12:10 — no data',
    ]);
  });

  test('every tone has its own shape, and no data has one too', () => {
    expect(heatCells(row).map((cell) => cell.shape)).toEqual(['square', 'cross', 'dash']);
    expect(new Set(HEAT_SHAPES.values()).size).toBe(HEAT_SHAPES.size);
  });

  test('two cells under one key in a row are refused, the key named', () => {
    const twice = { label: 'api', cells: [row.cells[0], row.cells[0]] } as never;
    expect(() => heatCells(twice)).toThrow(/12:00/);
  });
});
