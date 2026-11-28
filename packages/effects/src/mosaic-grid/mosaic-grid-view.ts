// MosaicGrid's rules: one function gives every tile's brightness and hue mix at any time, and the
// server's tiles (time 0) and every canvas frame are that function — the island's first frame is
// the page's, so the canvas never flashes in over a different picture.

import type { ColorRole } from '@ultimat3/ui';
import type { EffectBackend } from '../backend';
import type { CanvasDraw } from '../canvas-mount';
import { cssRgb, type Rgb } from '../palette';
import { rangeProp, rolesProp, roleVars } from '../props';

/** Server tiles do not animate: still until an island draws them on a canvas. */
export const MOSAIC_GRID_BACKEND: EffectBackend = 'static';

export const MOSAIC_GRID_ROLES: readonly ColorRole[] = ['accent', 'info'];

export interface MosaicCell {
  /** Tile opacity, 0..1. */
  readonly alpha: number;
  /** How far from the first role toward the second, 0..1. */
  readonly mix: number;
}

const round = (value: number): number => Math.round(value * 100) / 100;

/** Rounded to hundredths, so the server's custom properties and the canvas agree exactly. */
export function mosaicCell(col: number, row: number, time: number): MosaicCell {
  const wave =
    Math.sin(col * 0.55 + row * 0.9 + time * 1.2) * Math.cos(row * 0.35 - col * 0.2 - time * 0.7);
  return {
    alpha: round(0.18 + 0.62 * (0.5 + 0.5 * wave)),
    mix: round(0.5 + 0.5 * Math.sin((col - row) * 0.4 + time * 0.5)),
  };
}

export interface MosaicGridInput {
  readonly cols?: number | undefined;
  readonly rows?: number | undefined;
  readonly roles?: readonly ColorRole[] | undefined;
  readonly speed?: number | undefined;
}

export interface MosaicGridView {
  readonly cols: number;
  readonly rows: number;
  readonly roles: readonly ColorRole[];
  readonly speed: number;
  /** Frame 0, row-major. */
  readonly cells: readonly MosaicCell[];
  readonly vars: Record<string, string>;
}

export function mosaicGridView(input: MosaicGridInput): MosaicGridView {
  const cols = Math.round(
    rangeProp('MosaicGrid', 'cols', input.cols, { min: 4, max: 32, fallback: 16 }),
  );
  const rows = Math.round(
    rangeProp('MosaicGrid', 'rows', input.rows, { min: 3, max: 20, fallback: 9 }),
  );
  const roles = rolesProp('MosaicGrid', input.roles, MOSAIC_GRID_ROLES, { min: 2, max: 2 });
  const speed = rangeProp('MosaicGrid', 'speed', input.speed, { min: 0.25, max: 4, fallback: 1 });
  const cells: MosaicCell[] = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) cells.push(mosaicCell(col, row, 0));
  }
  return {
    cols,
    rows,
    roles,
    speed,
    cells,
    vars: { ...roleVars(roles), '--fx-cols': String(cols) },
  };
}

const lerp = (a: Rgb, b: Rgb, t: number): Rgb => [
  a[0] + (b[0] - a[0]) * t,
  a[1] + (b[1] - a[1]) * t,
  a[2] + (b[2] - a[2]) * t,
];

/** The canvas frame at `frame.time`: the same tiles `mosaicCell` gave the server, moving. */
export function drawMosaic(cols: number, rows: number, colours: () => readonly Rgb[]): CanvasDraw {
  return (ctx, frame) => {
    const [first, second] = colours();
    if (first === undefined || second === undefined) return;
    const width = frame.width / cols;
    const height = frame.height / rows;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const cell = mosaicCell(col, row, frame.time);
        ctx.fillStyle = cssRgb(lerp(first, second, cell.mix), cell.alpha);
        ctx.fillRect(col * width, row * height, width - 1, height - 1);
      }
    }
  };
}
