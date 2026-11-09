// The rules of a HeatStrip, apart from its markup: each cell's accessible name (the whole reading,
// never a colour), its shape per tone — so a cell reads in greyscale and to a colour-blind eye —
// and the refusal of two cells under one key in a row, which would make two nodes one.

import { renderCauseValue } from '@ultimat3/core';
import { UI_ERROR_CODES, UiError } from '../errors';
import type { Tone } from './variants';

export interface HeatCell {
  /** Unique within its row: a time bucket, a check id. */
  readonly key: string;
  /** Already translated, the whole reading: "12:00 — 3 failed of 40". It IS the cell's name. */
  readonly label: string;
  /** What the cell means; absent is no data. */
  readonly tone?: Tone | undefined;
  /** The page behind the cell: a linked cell is a link, an unlinked one no tab stop. */
  readonly href?: string | undefined;
}

export interface HeatRow {
  /** Already translated: the row's name — a service, a check. */
  readonly label: string;
  readonly cells: readonly HeatCell[];
}

/** A cell's mark: one shape per tone, so meaning never rides on colour alone. */
export type HeatShape = 'square' | 'circle' | 'triangle' | 'diamond' | 'cross' | 'ring' | 'dash';

export const HEAT_SHAPES: ReadonlyMap<Tone | 'none', HeatShape> = new Map([
  ['success', 'square'],
  ['info', 'circle'],
  ['accent', 'ring'],
  ['warning', 'triangle'],
  ['danger', 'cross'],
  ['neutral', 'diamond'],
  ['none', 'dash'],
]);

export interface HeatCellView {
  readonly key: string;
  readonly name: string;
  readonly tone: Tone | 'none';
  readonly shape: HeatShape;
  readonly href: string | undefined;
}

/** A row's cells as drawn, each named `row, reading` so a cell out of context still says whose. */
export function heatCells(row: HeatRow): readonly HeatCellView[] {
  const seen = new Set<string>();
  return row.cells.map((cell) => {
    if (seen.has(cell.key)) {
      throw new UiError({
        code: UI_ERROR_CODES.invalidValue,
        cause: `<HeatStrip> row ${renderCauseValue(row.label)} has two cells with key ${renderCauseValue(cell.key)}`,
        fix: 'cells: buckets.map((b) => ({ key: b.at.toISOString(), label, tone }))   # one cell per key in a row',
      });
    }
    seen.add(cell.key);
    const tone = cell.tone ?? 'none';
    return {
      key: cell.key,
      name: `${row.label}, ${cell.label}`,
      tone,
      shape: HEAT_SHAPES.get(tone) ?? 'dash',
      href: cell.href,
    };
  });
}
