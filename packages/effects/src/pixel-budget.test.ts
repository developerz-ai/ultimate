import { describe, expect, test } from 'bun:test';
import { backingSize, EFFECT_PIXELS } from './pixel-budget';

describe('unit · pixel budget', () => {
  test('one token holds the floor, the cap and the pixel ceiling', () => {
    expect(EFFECT_PIXELS.dprFloor).toBeLessThanOrEqual(EFFECT_PIXELS.dprCap);
    expect(Object.isFrozen(EFFECT_PIXELS)).toBe(true);
  });

  test('a 3x phone draws at the cap, never at its own ratio', () => {
    expect(backingSize(400, 300, 3)).toEqual({ width: 800, height: 600, scale: 2 });
  });

  test('a zoomed-out page (ratio below 1) still draws at the floor', () => {
    expect(backingSize(400, 300, 0.5)).toEqual({ width: 400, height: 300, scale: 1 });
  });

  test('a huge canvas is scaled under the pixel ceiling, even below the floor', () => {
    const size = backingSize(5120, 2880, 2);
    expect(size.width * size.height).toBeLessThanOrEqual(EFFECT_PIXELS.maxPixelCount);
    expect(size.scale).toBeLessThan(1);
  });

  test('a collapsed box still has a 1x1 backing store, never 0', () => {
    expect(backingSize(0, 0, 2)).toEqual({ width: 1, height: 1, scale: 2 });
  });

  test('a non-finite ratio reads as the floor', () => {
    expect(backingSize(10, 10, Number.NaN).scale).toBe(EFFECT_PIXELS.dprFloor);
  });
});
