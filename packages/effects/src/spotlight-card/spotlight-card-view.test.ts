import { describe, expect, test } from 'bun:test';
import {
  SPOTLIGHT_BACKEND,
  spotlightFocusPoint,
  spotlightPoint,
  spotlightVars,
} from './spotlight-card-view';

const card = { left: 100, top: 50, width: 200, height: 100 };

describe('spotlight geometry', () => {
  test('the pointer is relative to the card', () => {
    expect(spotlightPoint(card, 150, 80)).toEqual({ x: 50, y: 30 });
  });

  test('a drag outside the card is held on its edge', () => {
    expect(spotlightPoint(card, 9999, -9999)).toEqual({ x: 200, y: 0 });
  });

  test('keyboard focus lights the centre of the focused control', () => {
    const button = { left: 120, top: 60, width: 40, height: 20 };
    expect(spotlightFocusPoint(card, button)).toEqual({ x: 40, y: 20 });
  });

  test('vars are rounded px custom properties', () => {
    expect(spotlightVars({ x: 40.4, y: 20.6 })).toEqual({ '--spot-x': '40px', '--spot-y': '21px' });
  });

  test('no CSS animation, so the backend is the static tier', () => {
    expect(SPOTLIGHT_BACKEND).toBe('static');
  });
});
