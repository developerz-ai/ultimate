import { describe, expect, test } from 'bun:test';
import { sliderNumbers } from './slider-view';

describe('sliderNumbers', () => {
  test('defaults are 0 to 100 by 1, starting at min', () => {
    expect(sliderNumbers({})).toEqual({ min: 0, max: 100, step: 1, value: 0 });
  });

  test('a value is clamped into range and snapped to the step grid from min', () => {
    expect(sliderNumbers({ min: 0, max: 10, step: 2, value: 5 }).value).toBe(6);
    expect(sliderNumbers({ min: 1, max: 10, step: 2, value: 4 }).value).toBe(5);
    expect(sliderNumbers({ min: 0, max: 10, value: 99 }).value).toBe(10);
    expect(sliderNumbers({ min: 0, max: 10, value: -4 }).value).toBe(0);
    expect(sliderNumbers({ min: 0, max: 1, step: 0.1, value: 0.3 }).value).toBe(0.3);
  });

  test('a step of zero, a min not below max, and NaN are refused naming the prop', () => {
    expect(() => sliderNumbers({ step: 0 })).toThrow('Slider step');
    expect(() => sliderNumbers({ min: 5, max: 5 })).toThrow('Slider min');
    expect(() => sliderNumbers({ value: Number.NaN })).toThrow('value');
  });

  test('a fractional min anchors the grid: the snapped value is ON it, not rounded off it', () => {
    // The probe: rounding by the step's decimals alone dropped min's fraction — 3.5 read 4, a
    // value no thumb position names, and 0.75 read 0.8.
    expect(sliderNumbers({ min: 0.5, max: 10, step: 1, value: 3 }).value).toBe(3.5);
    expect(sliderNumbers({ min: 0.25, max: 5, step: 0.5, value: 0.75 }).value).toBe(0.75);
    expect(sliderNumbers({ min: 0.1, max: 1, step: 0.2, value: 0.7 }).value).toBe(0.7);
  });

  test('an exponent-form step keeps its decimals: 1e-7 is seven places, not zero', () => {
    expect(sliderNumbers({ min: 0, max: 1e-6, step: 1e-7, value: 5e-7 }).value).toBe(5e-7);
    expect(sliderNumbers({ min: 0, max: 1e-5, step: 2.5e-7, value: 5e-7 }).value).toBe(5e-7);
  });

  test('a max off the grid keeps the last step at or below it, never max itself', () => {
    // 0, 4, 8 — 10 is past the last step, and rounding 10 / 4 up to 12 then clamping read 10.
    expect(sliderNumbers({ min: 0, max: 10, step: 4, value: 10 }).value).toBe(8);
    expect(sliderNumbers({ min: 0.5, max: 2, step: 1, value: 2 }).value).toBe(1.5);
    // A max ON the grid is reached, float noise in `3 * 0.1` notwithstanding.
    expect(sliderNumbers({ min: 0, max: 0.3, step: 0.1, value: 0.3 }).value).toBe(0.3);
  });
});
