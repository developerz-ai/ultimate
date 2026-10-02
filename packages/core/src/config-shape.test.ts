// Single responsibility: pins the shape screens `defineConfig` runs before any rule reads a value —
// what each refuses, what each lets through, and that none of them can throw on what it is handed.

import { describe, expect, test } from 'bun:test';
import {
  booleanIssue,
  localeIssues,
  nameListIssues,
  oneOfIssue,
  routePathIssue,
  shapeIssues,
} from './config-shape';

const collect = (run: (issues: string[]) => void): readonly string[] => {
  const issues: string[] = [];
  run(issues);
  return issues;
};

describe('shapeIssues', () => {
  const reference = {
    jobs: { queues: ['q'], retry: { on: true } },
    tags: ['a'],
    colors: undefined,
  };

  test('a section or a list of the wrong kind is named by its full path', () => {
    const layer = { jobs: { queues: 'mail', retry: null }, tags: null };
    expect(collect((issues) => shapeIssues(reference, layer, issues))).toEqual([
      'jobs.queues must be a list, not a string of 4 characters',
      'jobs.retry must be an object, not null',
      'tags must be a list, not null',
    ]);
  });

  test('an unsaid key, a scalar and an optional block are not its business', () => {
    const layer = { jobs: { queues: undefined, extra: 5 }, colors: 'anything', unknown: null };
    expect(collect((issues) => shapeIssues(reference, layer, issues))).toEqual([]);
  });

  test('a list where a section belongs is refused — an array is not a record', () => {
    expect(collect((issues) => shapeIssues(reference, { jobs: [] }, issues))).toEqual([
      'jobs must be an object, not an empty array',
    ]);
  });

  test.each([[null], [undefined], [5], ['x'], [[]]])(
    'a layer that is %p raises nothing and throws nothing',
    (layer) => {
      expect(collect((issues) => shapeIssues(reference, layer, issues))).toEqual([]);
    },
  );
});

describe('the per-key screens', () => {
  test('oneOfIssue echoes a string and describes anything else', () => {
    expect(oneOfIssue('k', 'b', ['a', 'b'])).toBeUndefined();
    expect(oneOfIssue('k', 'c', ['a', 'b'])).toBe('k "c" is not one of a, b');
    expect(oneOfIssue('k', 5n, ['a'])).toContain('k ');
  });

  test('booleanIssue is typeof, never truthiness', () => {
    expect(booleanIssue('k', false)).toBeUndefined();
    expect(booleanIssue('k', 'false')).toBe('k must be true or false, not "false"');
    expect(booleanIssue('k', 0)).toContain('must be true or false');
  });

  test('routePathIssue wants a leading slash', () => {
    expect(routePathIssue('k', '/mcp')).toBeUndefined();
    expect(routePathIssue('k', 'mcp')).toBe('k must be a path starting with /, not "mcp"');
    expect(routePathIssue('k', null)).toContain('must be a path');
  });

  test('nameListIssues refuses an empty list, an empty name and a non-string', () => {
    expect(collect((issues) => nameListIssues('k', ['mail'], 'queue', issues))).toEqual([]);
    expect(collect((issues) => nameListIssues('k', [], 'queue', issues))).toEqual([
      'k must list at least one queue',
    ]);
    expect(collect((issues) => nameListIssues('k', ['', 5], 'queue', issues))).toHaveLength(2);
  });

  test('localeIssues refuses a non-tag, a second spelling of one locale and an absent default', () => {
    expect(collect((issues) => localeIssues(['en', 'pt-BR'], 'en', issues))).toEqual([]);
    expect(collect((issues) => localeIssues(['EN', 'en'], 'en', issues))).toEqual([
      'locales lists en twice, as "EN" and "en"',
    ]);
    expect(collect((issues) => localeIssues(['not a tag', 5], 'de', issues))).toEqual([
      'locales contains "not a tag", not a BCP-47 tag',
      'locales contains a number, not a BCP-47 tag',
      'defaultLocale "de" is not in locales',
    ]);
  });
});
