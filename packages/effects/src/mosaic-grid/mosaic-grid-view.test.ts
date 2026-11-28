import { describe, expect, test } from 'bun:test';
import { mountCanvas } from '../canvas-mount';
import { asCanvas, FakeCanvas, FakeHost } from '../fake-host-fixture';
import { drawMosaic, MOSAIC_GRID_BACKEND, mosaicCell, mosaicGridView } from './mosaic-grid-view';

describe('unit · MosaicGrid view', () => {
  test('the server tiles are frame 0 of the same function the canvas draws', () => {
    const view = mosaicGridView({ cols: 4, rows: 3 });
    expect(view.cells).toHaveLength(12);
    expect(view.cells[5]).toEqual(mosaicCell(1, 1, 0));
  });

  test('the canvas first frame paints the server frame, tile for tile', () => {
    const canvas = new FakeCanvas();
    const host = new FakeHost();
    host.size = [40, 30];
    const fills: unknown[] = [];
    const ctx = canvas.ctx;
    if (ctx === null) return expect.unreachable('the fake has a 2D context');
    const fillRect = ctx.fillRect.bind(ctx);
    ctx.fillRect = (...args: number[]) => {
      fills.push(ctx.fillStyle);
      fillRect(...args);
    };
    const red = [1, 0, 0] as const;
    const blue = [0, 0, 1] as const;
    mountCanvas(
      asCanvas(canvas),
      drawMosaic(4, 3, () => [red, blue]),
      host,
      { speed: 1 },
    );
    host.frame();
    expect(fills).toHaveLength(12);
    const cell = mosaicCell(0, 0, 0);
    const r = Math.round((1 - cell.mix) * 255);
    const b = Math.round(cell.mix * 255);
    expect(fills[0]).toBe(`rgb(${r} 0 ${b} / ${cell.alpha})`);
  });

  test('tiles move with time and stay inside their ranges', () => {
    expect(mosaicCell(3, 2, 0)).not.toEqual(mosaicCell(3, 2, 1));
    for (let t = 0; t < 10; t += 0.7) {
      const cell = mosaicCell(5, 4, t);
      expect(cell.alpha).toBeGreaterThanOrEqual(0.18);
      expect(cell.alpha).toBeLessThanOrEqual(0.8);
      expect(cell.mix).toBeGreaterThanOrEqual(0);
      expect(cell.mix).toBeLessThanOrEqual(1);
    }
  });

  test('server tier is static; 40 columns or one role is X_EFFECTS_INVALID_VALUE', () => {
    expect(MOSAIC_GRID_BACKEND).toBe('static');
    expect(() => mosaicGridView({ cols: 40 })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
    expect(() => mosaicGridView({ roles: ['accent'] })).toThrow(
      expect.objectContaining({ code: 'X_EFFECTS_INVALID_VALUE' }),
    );
  });
});
