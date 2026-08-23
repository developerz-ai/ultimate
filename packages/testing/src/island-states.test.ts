// `defineIslandStates` is the one gate between an author's declaration and a picture nobody takes.
// Every case here is a declaration that LOOKS fine and produces a wrong or missing screenshot, so
// each asserts the code AND the instruction — a refusal that does not name the edit is a crash.

import { describe, expect, test } from 'bun:test';
import { defineIslandStates } from './define-island-states';
import { DEFAULT_NOW } from './determinism';
import { islandStatesFile } from './island-state-errors';
import {
  DEFAULT_ISLAND_VIEWPORT,
  ISLAND_SHOT_TIME_ZONE,
  ISLAND_THEMES,
  isIslandStatesManifest,
  islandStatesName,
} from './island-states';
import { jsonFault } from './island-states-check';
import { testName } from './test-types';

const ISLAND = 'apps/web/app/settings/settings.island.tsx';

const ok = { id: 'read-only', title: 'the account is read-only', props: { readOnly: true } };

describe(testName('unit', 'defineIslandStates'), () => {
  test('refuses a manifest with no states — it expands to nothing and exits 0', () => {
    expect(() => defineIslandStates({ island: ISLAND, states: [] })).toThrow(
      expect.objectContaining({ code: 'X_TEST_ISLAND_STATES_EMPTY' }),
    );
  });

  test('refuses an id that is not a slug, and the fix is the slug it meant', () => {
    try {
      defineIslandStates({
        island: ISLAND,
        states: [{ id: 'Over Quota', title: 'over quota', props: {} }],
      });
      expect.unreachable('a non-slug id has to be refused: it becomes a filename stem');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATE_ID_INVALID');
      expect((error as { fix: string }).fix).toContain("id: 'over-quota'");
      expect((error as { fix: string }).fix).toContain(islandStatesFile(ISLAND));
    }
  });

  test('refuses two states with one id — the second picture would overwrite the first', () => {
    expect(() =>
      defineIslandStates({ island: ISLAND, states: [ok, { ...ok, title: 'again' }] }),
    ).toThrow(expect.objectContaining({ code: 'X_TEST_ISLAND_STATE_DUPLICATE' }));
  });

  test('refuses props JSON drops, and names where the value sits', () => {
    try {
      defineIslandStates({
        island: ISLAND,
        states: [{ id: 'stale', title: 'stale', props: { user: { seenAt: new Date(0) } } }],
      });
      expect.unreachable('a Date reaches the island as a string, or not at all');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATE_JSON_INVALID');
      expect((error as { cause: string }).cause).toContain('props.user.seenAt');
    }
  });

  test('refuses a stub body JSON cannot carry, naming the stub it is in', () => {
    try {
      defineIslandStates({
        island: ISLAND,
        states: [
          {
            id: 'quota',
            title: 'over quota',
            props: {},
            routes: [{ match: 'GET /api/quota', respond: { kind: 'json', body: { at: () => 1 } } }],
          },
        ],
      });
      expect.unreachable('a function in a stub body is a response the harness cannot send');
    } catch (error) {
      expect(error).toBeUltimateError('X_TEST_ISLAND_STATE_JSON_INVALID');
      expect((error as { cause: string }).cause).toContain('routes[0].respond.body.at');
    }
  });

  test('refuses a stub match that is not "<METHOD> <pathname>" — it would match nothing', () => {
    expect(() =>
      defineIslandStates({
        island: ISLAND,
        states: [{ ...ok, routes: [{ match: '/api/quota', respond: { kind: 'pending' } }] }],
      }),
    ).toThrow(expect.objectContaining({ code: 'X_TEST_ISLAND_STATE_STUB_INVALID' }));
  });

  test('refuses a zone Intl does not know — a date would fall back to the host machine', () => {
    expect(() =>
      defineIslandStates({ island: ISLAND, states: [ok], timeZone: 'Europe/Bucarest' }),
    ).toThrow(expect.objectContaining({ code: 'X_TEST_ISLAND_STATE_CLOCK_INVALID' }));
  });

  test('refuses an instant with no offset — it is a different moment on every machine', () => {
    expect(() =>
      defineIslandStates({ island: ISLAND, states: [ok], now: '2026-01-01T00:00:00' }),
    ).toThrow(expect.objectContaining({ code: 'X_TEST_ISLAND_STATE_CLOCK_INVALID' }));
  });

  test('pins UTC and the suite’s own frozen instant when the manifest says nothing', () => {
    const manifest = defineIslandStates({ island: ISLAND, states: [ok] });
    expect(manifest.timeZone).toBe(ISLAND_SHOT_TIME_ZONE);
    expect(ISLAND_SHOT_TIME_ZONE).toBe('UTC');
    expect(manifest.now).toBe(DEFAULT_NOW);
  });

  test('defaults to BOTH themes, and dedupes a list that repeats one', () => {
    const manifest = defineIslandStates({
      island: ISLAND,
      states: [ok, { ...ok, id: 'dark-only', themes: ['dark', 'dark'] }],
    });
    expect(manifest.states[0]?.themes).toEqual([...ISLAND_THEMES]);
    expect(manifest.states[1]?.themes).toEqual(['dark']);
  });

  test('a state viewport inherits the manifest one, which inherits the default', () => {
    const manifest = defineIslandStates({
      island: ISLAND,
      states: [ok, { ...ok, id: 'wide', viewport: { width: 1600, height: 900 } }],
      viewport: { width: 900, height: 600 },
    });
    expect(manifest.states[0]?.viewport).toEqual({ width: 900, height: 600 });
    expect(manifest.states[1]?.viewport).toEqual({ width: 1600, height: 900 });
    expect(defineIslandStates({ island: ISLAND, states: [ok] }).viewport).toEqual(
      DEFAULT_ISLAND_VIEWPORT,
    );
  });

  test('a viewport a browser cannot be sized to inherits rather than photographing 0px', () => {
    const manifest = defineIslandStates({
      island: ISLAND,
      states: [ok],
      viewport: { width: 0, height: 800 },
    });
    expect(manifest.viewport).toEqual(DEFAULT_ISLAND_VIEWPORT);
  });

  test('freezes the manifest all the way down, so no harness can poison a later picture', () => {
    const manifest = defineIslandStates({
      island: ISLAND,
      states: [{ ...ok, props: { rows: [{ id: 1 }] } }],
    });
    expect(Object.isFrozen(manifest)).toBe(true);
    expect(Object.isFrozen(manifest.states)).toBe(true);
    expect(Object.isFrozen(manifest.states[0]?.props)).toBe(true);
    const rows = manifest.states[0]?.props['rows'] as readonly unknown[];
    expect(Object.isFrozen(rows[0])).toBe(true);
  });

  test('carries the brand, so a loader can tell a manifest from every other export', () => {
    expect(isIslandStatesManifest(defineIslandStates({ island: ISLAND, states: [ok] }))).toBe(true);
    expect(isIslandStatesManifest({ island: ISLAND, states: [], name: 'settings' })).toBe(false);
    expect(isIslandStatesManifest(null)).toBe(false);
  });

  test('the name is the island filename, which is the shot directory a reader guesses', () => {
    expect(islandStatesName(ISLAND)).toBe('settings');
    expect(islandStatesName('site/pricing/contact-sales.island.tsx')).toBe('contact-sales');
    expect(defineIslandStates({ island: ISLAND, states: [ok] }).name).toBe('settings');
  });
});

describe(testName('unit', 'jsonFault'), () => {
  test('names every value JSON degrades instead of refusing', () => {
    expect(jsonFault({ a: undefined }, 'props')?.path).toBe('props.a');
    expect(jsonFault({ a: Number.NaN }, 'props')?.path).toBe('props.a');
    expect(jsonFault({ a: 10n }, 'props')?.path).toBe('props.a');
    expect(jsonFault({ a: Symbol('x') }, 'props')?.path).toBe('props.a');
    expect(jsonFault({ a: new Map() }, 'props')?.path).toBe('props.a');
    expect(jsonFault({ a: [1, { b: () => 1 }] }, 'props')?.path).toBe('props.a[1].b');
  });

  test('finds a cycle instead of overflowing the stack rendering it', () => {
    const props: Record<string, unknown> = { name: 'a' };
    props['self'] = props;
    expect(jsonFault(props, 'props')).toEqual({ path: 'props.self', reason: 'a cycle' });
  });

  test('passes everything JSON does carry, repeated values included', () => {
    const shared = { id: 1 };
    expect(jsonFault({ a: shared, b: shared, c: [null, true, 'x', 1.5] }, 'props')).toBeUndefined();
  });
});
