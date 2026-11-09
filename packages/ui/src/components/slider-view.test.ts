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
});
