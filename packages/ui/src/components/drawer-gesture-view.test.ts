import { describe, expect, test } from 'bun:test';
import { dragOffset, releaseSnap } from './drawer-gesture-view';

describe('drawer drag', () => {
  test('down follows the finger; up resists from half and stops at full', () => {
    expect(dragOffset(120, 'half')).toBe(120);
    expect(dragOffset(-90, 'half')).toBe(-30);
    expect(dragOffset(-90, 'full')).toBe(0);
    expect(dragOffset(Number.NaN, 'half')).toBe(0);
  });

  test('past half the height closes, from either snap', () => {
    expect(releaseSnap(201, 400, 'half')).toBe('close');
    expect(releaseSnap(401, 800, 'full')).toBe('close');
    expect(releaseSnap(200, 400, 'half')).toBe('half');
  });

  test('a fifth moves between snaps; less settles back', () => {
    expect(releaseSnap(-81, 400, 'half')).toBe('full');
    expect(releaseSnap(-79, 400, 'half')).toBe('half');
    expect(releaseSnap(161, 800, 'full')).toBe('half');
    expect(releaseSnap(159, 800, 'full')).toBe('full');
  });

  test('a sheet with no height never closes on a drag', () => {
    expect(releaseSnap(500, 0, 'half')).toBe('half');
  });
});
