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

  test('a __proto__ key in the parsed subset stays a key', () => {
    const island = subsetTranslator(
      JSON.parse('{"locale":"en","catalog":{"__proto__":"x","ui.retry":"Retry"}}'),
    );
    expect(island('ui.retry')).toBe('Retry');
    expect(island('toString')).toBe('⟦toString⟧');
  });
});
