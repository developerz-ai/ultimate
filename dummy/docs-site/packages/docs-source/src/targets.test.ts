import { describe, expect, test } from 'bun:test';
import { pageOfFile, pageUrl, wikiTarget } from './targets';

describe('wikiTarget', () => {
  test.each([
    ['Getting-Started', { page: 'Getting-Started', anchor: undefined }],
    ['Deployment.md#through-a-pooler', { page: 'Deployment', anchor: 'through-a-pooler' }],
    ['#here', { page: 'FAQ', anchor: 'here' }],
    ['_Footer', { page: '_Footer', anchor: undefined }],
    [
      'https://github.com/developerz-ai/ultimate/wiki/SEO#robots',
      { page: 'SEO', anchor: 'robots' },
    ],
    [
      'https://github.com/developerz-ai/ultimate/blob/main/wiki/Money.md',
      { page: 'Money', anchor: undefined },
    ],
    ['Upgrading#29x--3000-entry%20by', { page: 'Upgrading', anchor: '29x--3000-entry by' }],
  ])('%s is a wiki link', (target, expected) => {
    expect(wikiTarget(target, 'FAQ')).toEqual(expected);
  });

  test.each([
    'https://github.com/developerz-ai/ultimate/blob/main/CHANGELOG.md',
    'https://example.com/Getting-Started',
    'mailto:a@b.c',
    'packages/core/README.md',
  ])('%s is not', (target) => {
    expect(wikiTarget(target, 'FAQ')).toBeUndefined();
  });
});

test('pageOfFile and pageUrl', () => {
  expect(pageOfFile('Getting-Started.md')).toBe('Getting-Started');
  expect(pageOfFile('_Sidebar.md')).toBeUndefined();
  expect(pageOfFile('notes.txt')).toBeUndefined();
  expect(pageUrl('CLI-Reference')).toBe('/cli-reference');
  expect(pageUrl('Home')).toBe('/docs');
});
