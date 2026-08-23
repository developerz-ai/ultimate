// The expansion is what makes "the command produced nothing" a refusable state: the expected file
// list exists before a browser does. So these pin the SHAPE of that list — one record per picture,
// a path an agent can guess, and an address that survives the round trip in both directions.

import { describe, expect, test } from 'bun:test';
import { defineIslandStates } from './define-island-states';
import {
  islandAddress,
  islandShotPlan,
  islandShotTargets,
  parseIslandAddress,
} from './island-shot-targets';
import { DEFAULT_ISLAND_THEME } from './island-states';
import { testName } from './test-types';

const ISLAND = 'apps/web/app/settings/settings.island.tsx';

const manifest = defineIslandStates({
  island: ISLAND,
  target: '[data-panel]',
  states: [
    { id: 'read-only', title: 'read-only', props: { readOnly: true } },
    { id: 'over-quota', title: 'over quota', props: {}, themes: ['dark'] },
  ],
});

describe(testName('unit', 'islandShotTargets'), () => {
  test('is one record per state per theme, in declaration order', () => {
    expect(islandShotTargets(manifest).map((shot) => `${shot.state}-${shot.theme}`)).toEqual([
      'read-only-light',
      'read-only-dark',
      'over-quota-dark',
    ]);
  });

  test('the file is <island>/<state>-<theme>.png — flat, because the reader guesses it', () => {
    expect(islandShotTargets(manifest).map((shot) => shot.file)).toEqual([
      'settings/read-only-light.png',
      'settings/read-only-dark.png',
      'settings/over-quota-dark.png',
    ]);
  });

  test('carries the pinned clock onto every picture, never leaving the zone to the host', () => {
    for (const shot of islandShotTargets(manifest)) {
      expect(shot.timeZone).toBe('UTC');
      expect(shot.now).toBe(manifest.now);
    }
  });

  test('a selector beats the manifest, and no selector at all leaves the key off', () => {
    expect(islandShotTargets(manifest)[0]?.target).toBe('[data-panel]');
    expect(islandShotTargets(manifest, '#root')[0]?.target).toBe('#root');
    const bare = defineIslandStates({
      island: ISLAND,
      states: [{ id: 'a', title: 'a', props: {} }],
    });
    expect(islandShotTargets(bare)[0]).not.toHaveProperty('target');
  });

  test('a plan over two manifests gives every picture a path of its own', () => {
    const other = defineIslandStates({
      island: 'apps/web/site/pricing/contact-sales.island.tsx',
      states: [{ id: 'sent', title: 'sent', props: {} }],
    });
    const files = islandShotPlan([manifest, other]).map((shot) => shot.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files).toContain('contact-sales/sent-light.png');
  });
});

describe(testName('unit', 'parseIslandAddress'), () => {
  test('round-trips every target the expansion produces', () => {
    for (const shot of islandShotPlan([manifest])) {
      expect(parseIslandAddress(shot.query)).toEqual({
        island: shot.island,
        state: shot.state,
        theme: shot.theme,
      });
    }
  });

  test('round-trips a path with characters a query string has to escape', () => {
    const address = { island: 'apps/web/app/a b/x.island.tsx', state: 's', theme: 'dark' } as const;
    expect(parseIslandAddress(islandAddress(address))).toEqual(address);
  });

  test('reads an address written without its leading ?', () => {
    expect(parseIslandAddress('island=a&state=b&theme=dark').theme).toBe('dark');
  });

  test('falls back on an unknown theme rather than throwing — a typo shows the component', () => {
    expect(parseIslandAddress('?island=a&state=b&theme=sepia').theme).toBe(DEFAULT_ISLAND_THEME);
    expect(parseIslandAddress('').theme).toBe(DEFAULT_ISLAND_THEME);
    expect(parseIslandAddress('?nonsense')).toEqual({
      island: '',
      state: '',
      theme: DEFAULT_ISLAND_THEME,
    });
  });
});
