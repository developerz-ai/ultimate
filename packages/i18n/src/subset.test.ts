// A catalog slice that crosses into an island: the server resolves the templates, plural forms
// included, and the island's translator renders them exactly as the server's would — misses loud.

import { describe, expect, test } from 'bun:test';
import { catalogSubset, subsetTranslator } from './subset';
import { catalogTranslator, isMiss } from './translator';

const server = catalogTranslator(
  {
    'ui.retry': 'Try again',
    'app.likes_one': '{count} like',
    'app.likes_other': '{count} likes',
    'app.hello': 'Hello {name}',
    'app.unsent': 'never sent',
  },
  'en',
);

describe('catalogSubset', () => {
  test('carries the named templates and every plural form, and nothing else', () => {
    const subset = catalogSubset(server, ['ui.retry', 'app.likes', 'app.hello', 'app.gone']);
    expect(subset.locale).toBe('en');
    expect({ ...subset.catalog }).toEqual({
      'ui.retry': 'Try again',
      'app.likes_one': '{count} like',
      'app.likes_other': '{count} likes',
      'app.hello': 'Hello {name}',
    });
  });

  test('the island translator renders as the server does, through JSON', () => {
    const subset = catalogSubset(server, ['ui.retry', 'app.likes', 'app.hello']);
    const island = subsetTranslator(JSON.parse(JSON.stringify(subset)));
    for (const [key, vars] of [
      ['ui.retry', undefined],
      ['app.likes', { count: 1 }],
      ['app.likes', { count: 3 }],
      ['app.hello', { name: 'Ada' }],
    ] as const) {
      expect(island(key, vars)).toBe(server(key, vars));
    }
    expect(island('app.unsent')).toBe('⟦app.unsent⟧');
    expect(island.locale).toBe('en');
  });

  test("a subset carries a key's select and ordinal families, composed with plurals, and the island renders what the server does", () => {
    const families = catalogTranslator(
      {
        'app.invite_select_female': 'She invited you',
        'app.invite_select_other_one': 'They sent {count} invite',
        'app.invite_select_other_other': 'They sent {count} invites',
        'app.place_ordinal_one': '{ordinal}st',
        'app.place_ordinal_other': '{ordinal}th',
        'app.invited': 'not a member of app.invite',
        'app.other_select_a': 'another key entirely',
      },
      'en',
    );
    const subset = catalogSubset(families, ['app.invite', 'app.place']);
    expect(Object.keys(subset.catalog).sort()).toEqual([
      'app.invite_select_female',
      'app.invite_select_other_one',
      'app.invite_select_other_other',
      'app.place_ordinal_one',
      'app.place_ordinal_other',
    ]);
    const island = subsetTranslator(JSON.parse(JSON.stringify(subset)));
    for (const [key, vars] of [
      ['app.invite', { select: 'female' }],
      ['app.invite', { select: 'male', count: 1 }],
      ['app.invite', { select: 'male', count: 4 }],
      ['app.place', { ordinal: 1 }],
      ['app.place', { ordinal: 4 }],
    ] as const) {
      expect(island(key, vars)).toBe(families(key, vars));
      expect(isMiss(island(key, vars))).toBe(false);
    }
  });

  test("a second subset from one translator lists the catalog's keys no second time", () => {
    let listed = 0;
    const counted = Object.assign((key: string) => server(key), {
      raw: server.raw,
      keys: (): string[] => {
        listed += 1;
        return server.keys();
      },
      locale: server.locale,
    });
    catalogSubset(counted, ['ui.retry']);
    catalogSubset(counted, ['app.likes']);
    expect(listed).toBe(1);
  });

  // The first subset builds the family index. Copying a stem's member list per member made one
  // family of n members cost n²/2 element steps; counted, not timed, so load cannot flake it.
  test('one select family of n members is indexed in steps linear in n', () => {
    const stepsFor = (n: number): number => {
      const names = Array.from({ length: n }, (_, at) => `app.pick_select_v${at}`);
      const family = { raw: (): string => 'x', keys: (): string[] => names, locale: server.locale };
      const original = Array.prototype[Symbol.iterator];
      let steps = 0;
      // Every array walk the index build makes — `for…of`, a spread — goes through this iterator.
      Reflect.set(Array.prototype, Symbol.iterator, function counted(this: unknown[]) {
        const walk = original.call(this);
        return {
          next: () => {
            steps += 1;
            return walk.next();
          },
          [Symbol.iterator]() {
            return this;
          },
        };
      });
      try {
        catalogSubset(family, []);
      } finally {
        Reflect.set(Array.prototype, Symbol.iterator, original);
      }
      return steps;
    };
    const small = stepsFor(1_000);
    expect(small).toBeGreaterThan(1_000);
    expect(stepsFor(2_000)).toBeLessThan(3 * small);
  });

  test('a __proto__ key in the parsed subset stays a key', () => {
    const island = subsetTranslator(
      JSON.parse('{"locale":"en","catalog":{"__proto__":"x","ui.retry":"Retry"}}'),
    );
    expect(island('ui.retry')).toBe('Retry');
    expect(island('toString')).toBe('⟦toString⟧');
  });
});
