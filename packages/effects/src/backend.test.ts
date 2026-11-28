import { describe, expect, test } from 'bun:test';
import { type BackendInput, pickBackend } from './backend';

const island: BackendInput = {
  motion: true,
  hydrated: true,
  css: true,
  wants: 'webgl2',
  webgl2: true,
  canvas: true,
  lost: false,
};

describe('unit · backend selection', () => {
  test('a hydrated island with WebGL2 draws with it', () => {
    expect(pickBackend(island)).toBe('webgl2');
  });

  test('no WebGL2 falls to Canvas2D', () => {
    expect(pickBackend({ ...island, webgl2: false })).toBe('canvas');
  });

  test('a lost context falls to the CSS frame, not a canvas it can no longer get', () => {
    expect(pickBackend({ ...island, lost: true })).toBe('css');
    expect(pickBackend({ ...island, lost: true, css: false })).toBe('static');
  });

  test('reduced motion or a user pause is static, whatever the hardware', () => {
    expect(pickBackend({ ...island, motion: false })).toBe('static');
  });

  test('before hydration: css when the CSS animates, static when it does not', () => {
    expect(pickBackend({ ...island, hydrated: false })).toBe('css');
    expect(pickBackend({ ...island, hydrated: false, css: false })).toBe('static');
  });

  test('an entry that only wants CSS stays CSS in an island', () => {
    expect(pickBackend({ ...island, wants: 'css' })).toBe('css');
  });

  test('an entry that wants canvas never climbs to WebGL2', () => {
    expect(pickBackend({ ...island, wants: 'canvas' })).toBe('canvas');
  });

  test('neither context: the CSS frame', () => {
    expect(pickBackend({ ...island, webgl2: false, canvas: false })).toBe('css');
  });
});
