// A catalog slice that crosses into an island: the server resolves the templates, plural forms
// included, and the island's translator renders them exactly as the server's would — misses loud.

import { describe, expect, test } from 'bun:test';
import { catalogSubset, subsetTranslator } from './subset';
import { catalogTranslator } from './translator';

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

  test('a __proto__ key in the parsed subset stays a key', () => {
    const island = subsetTranslator(
      JSON.parse('{"locale":"en","catalog":{"__proto__":"x","ui.retry":"Retry"}}'),
    );
    expect(island('ui.retry')).toBe('Retry');
    expect(island('toString')).toBe('⟦toString⟧');
  });
});
