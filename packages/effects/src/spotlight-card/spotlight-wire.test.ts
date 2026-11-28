import { describe, expect, test } from 'bun:test';
import { spotlightFocus, spotlightPointer } from './spotlight-wire';

const card = () => {
  const props = new Map<string, string>();
  return {
    props,
    getBoundingClientRect: () => ({ left: 100, top: 50, width: 200, height: 100 }),
    style: { setProperty: (n: string, v: string) => void props.set(n, v) },
  };
};

describe('spotlight wiring', () => {
  test('the pointer sets the two custom properties', () => {
    const el = card();
    spotlightPointer(el, 150, 80);
    expect(Object.fromEntries(el.props)).toEqual({ '--spot-x': '50px', '--spot-y': '30px' });
  });

  test('keyboard focus aims at the focused control', () => {
    const el = card();
    spotlightFocus(el, {
      matches: (s) => s === ':focus-visible',
      getBoundingClientRect: () => ({ left: 120, top: 60, width: 40, height: 20 }),
    });
    expect(Object.fromEntries(el.props)).toEqual({ '--spot-x': '40px', '--spot-y': '20px' });
  });

  test('a mouse-focused control does not aim', () => {
    const el = card();
    spotlightFocus(el, {
      matches: () => false,
      getBoundingClientRect: () => card().getBoundingClientRect(),
    });
    expect(el.props.size).toBe(0);
  });
});
