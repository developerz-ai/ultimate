import { describe, expect, test } from 'bun:test';
import { GAUGE, gaugeArcs, gaugeFillEnd } from './gauge-view';

describe('gaugeFillEnd', () => {
  test('the dial runs 270°, from seven-thirty to four-thirty through twelve', () => {
    expect(gaugeFillEnd(0)).toBeCloseTo(GAUGE.from);
    expect(gaugeFillEnd(0.5)).toBeCloseTo(0);
    expect(gaugeFillEnd(1)).toBeCloseTo(GAUGE.from + GAUGE.sweep);
    expect(GAUGE.sweep).toBeCloseTo(Math.PI * 1.5);
  });
});

describe('gaugeArcs', () => {
  test('the track is the whole dial and the fill stops at the share', () => {
    const arcs = gaugeArcs(0.5);
    expect(arcs.track).toMatch(/^M.* Z$/);
    expect(arcs.fill).toMatch(/^M.* Z$/);
    // Half the dial is 135° — under half a turn, so the fill never takes the large arc.
    expect(arcs.fill).toContain(' 0 0 1 ');
    expect(arcs.track).toContain(' 0 1 1 ');
  });

  test('an empty gauge draws its track and no fill', () => {
    expect(gaugeArcs(0).fill).toBe('');
    expect(gaugeArcs(0).track).not.toBe('');
  });

  test('a full gauge fills exactly the track', () => {
    expect(gaugeArcs(1).fill).toBe(gaugeArcs(1).track);
  });

  test('a share outside 0..1 is clamped, never drawn past the dial', () => {
    expect(gaugeArcs(3).fill).toBe(gaugeArcs(1).fill);
    expect(gaugeArcs(-1).fill).toBe('');
    expect(gaugeArcs(Number.NaN).fill).toBe('');
  });

  test('the box holds the whole dial: the lowest point of the ring is inside the viewBox', () => {
    const lowest = GAUGE.centre + GAUGE.outer * Math.cos(Math.PI - GAUGE.sweep / 2);
    expect(lowest).toBeLessThanOrEqual(GAUGE.height);
  });
});
