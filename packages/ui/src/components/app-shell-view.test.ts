// A skip link that points at nothing still looks right on screen — which is exactly why the
// derivation is pinned here rather than trusted to the JSX.

import { describe, expect, test } from 'bun:test';
import { shellIds, shellLandmarks } from './app-shell-view';

describe('shellIds', () => {
  test('the skip target is always the main region', () => {
    const ids = shellIds('shell-7');
    expect(ids.mainId).toBe('shell-7-main');
    expect(ids.skipHref).toBe(`#${ids.mainId}`);
  });

  test('two shells on one page never collide', () => {
    expect(shellIds('a').mainId).not.toBe(shellIds('b').mainId);
  });
});

describe('shellLandmarks', () => {
  test('emits every filled region in screen-reader order', () => {
    expect(shellLandmarks({ header: true, sidebar: true, footer: true })).toEqual([
      'banner',
      'navigation',
      'main',
      'contentinfo',
    ]);
  });

  test('omits the regions the app did not fill', () => {
    expect(shellLandmarks({ header: false, sidebar: false, footer: false })).toEqual(['main']);
    expect(shellLandmarks({ header: true, sidebar: false, footer: false })).toEqual([
      'banner',
      'main',
    ]);
    expect(shellLandmarks({ header: false, sidebar: true, footer: true })).toEqual([
      'navigation',
      'main',
      'contentinfo',
    ]);
  });

  test('main is present exactly once, whatever the slots', () => {
    for (const header of [true, false]) {
      for (const sidebar of [true, false]) {
        for (const footer of [true, false]) {
          const landmarks = shellLandmarks({ header, sidebar, footer });
          expect(landmarks.filter((landmark) => landmark === 'main')).toHaveLength(1);
        }
      }
    }
  });
});
