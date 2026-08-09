import { describe, expect, test } from 'bun:test';
import { derivePath, splitWords, toKebabCase, toToolName } from './naming';

describe('query naming', () => {
  test('the wire path is the kebab-cased export name under one prefix', () => {
    expect(derivePath('liveFeed')).toBe('/_x/query/live-feed');
    expect(derivePath('postById')).toBe('/_x/query/post-by-id');
    expect(derivePath('feed')).toBe('/_x/query/feed');
  });

  test('an MCP tool name is snake_case', () => {
    expect(toToolName('liveFeed')).toBe('live_feed');
    expect(toToolName('publicPostSlugs')).toBe('public_post_slugs');
  });

  test('acronyms split on the last capital, not the first', () => {
    expect(splitWords('postHTMLBody')).toEqual(['post', 'html', 'body']);
    expect(toKebabCase('postHTMLBody')).toBe('post-html-body');
  });

  test('the derivation is pure string math — no registry, no schema', () => {
    // A query the app never declared still derives a path, which is what lets the browser
    // client build the URL without importing a byte of server code.
    expect(derivePath('never_declared')).toBe('/_x/query/never-declared');
  });
});
