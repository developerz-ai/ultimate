// The chart palette's colour-blind claim, as a build error: eight series that stay apart for a
// reader with protanopia, deuteranopia or tritanopia, in both themes. Contrast against the page
// says a mark can be FOUND; this says it can be told from the next one.

import { describe, expect, test } from 'bun:test';
import {
  CHART_DISTINCT_MIN,
  COLOUR_VISIONS,
  closestChartPair,
  colourDistance,
  simulateColourVision,
} from './colour-vision';
import { CHART_ROLES, colorTokens, type Theme } from './tokens';

const THEMES: readonly Theme[] = ['light', 'dark'];

describe('simulateColourVision', () => {
  test('typical vision is the identity', () => {
    expect(simulateColourVision('31 110 178', 'typical')).toBe('31 110 178');
  });

  test('greys survive every deficiency — the matrices preserve the achromatic axis', () => {
    for (const vision of COLOUR_VISIONS) {
      for (const grey of ['0 0 0', '128 128 128', '255 255 255']) {
        const [r = 0, g = 0, b = 0] = simulateColourVision(grey, vision).split(' ').map(Number);
        expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThanOrEqual(2);
      }
    }
  });

  test('red and green collapse for a deutan reader and stay apart for a typical one', () => {
    // The textbook confusion pair: if the simulation does not merge these, it simulates nothing.
    const red = '200 60 40';
    const green = '90 140 40';
    expect(colourDistance(red, green)).toBeGreaterThan(40);
    expect(
      colourDistance(simulateColourVision(red, 'deutan'), simulateColourVision(green, 'deutan')),
    ).toBeLessThan(20);
  });

  test('distance is zero for one colour and symmetric for two', () => {
    expect(colourDistance('31 110 178', '31 110 178')).toBe(0);
    expect(colourDistance('0 0 0', '255 255 255')).toBeCloseTo(100, 0);
    expect(colourDistance('10 20 30', '200 100 0')).toBe(colourDistance('200 100 0', '10 20 30'));
  });
});

describe('the shipped chart series are colour-blind safe', () => {
  test('every pair stays apart under every simulated vision, in both themes', () => {
    const failures = THEMES.flatMap((theme) => {
      const palette = CHART_ROLES.map((role) => colorTokens[theme][role]);
      const closest = closestChartPair(palette);
      return closest.distance >= CHART_DISTINCT_MIN
        ? []
        : [
            `${theme}: chart-${closest.a + 1} vs chart-${closest.b + 1} (${closest.vision}) = ${closest.distance.toFixed(1)}`,
          ];
    });
    expect(failures).toEqual([]);
  });

  test('the floor is a real bar — a palette with two near-twins is reported', () => {
    const twins = ['0 107 170', '0 110 172', '189 44 16'];
    const closest = closestChartPair(twins);
    expect(closest.distance).toBeLessThan(CHART_DISTINCT_MIN);
    expect([closest.a, closest.b]).toEqual([0, 1]);
  });

  test('a red/green pair that only a typical reader can split is reported, and by which vision', () => {
    const closest = closestChartPair(['200 60 40', '90 140 40']);
    expect(closest.distance).toBeLessThan(CHART_DISTINCT_MIN);
    expect(['protan', 'deutan']).toContain(closest.vision);
  });
});
