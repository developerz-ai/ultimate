// Which release tags a shapeless lock is re-baselined from: the lock's own version and the ones
// before it, and — when that tag is not fetched — the newest below it, never one above.

import { describe, expect, test } from 'bun:test';
import { MIGRATION_TAG_DEPTH, tagsBelow } from './public-api-migrate';

const TAGS = ['v31.27.0', 'v31.25.0', 'v31.24.0', 'v31.23.0', 'v31.22.0', 'v31.21.0', 'v-dev'];

describe('public-api-migrate · tagsBelow', () => {
  test("the lock's own tag first, then the ones before it, as deep as the depth", () => {
    expect(tagsBelow(TAGS, '31.25.0')).toEqual(TAGS.slice(1, 1 + MIGRATION_TAG_DEPTH));
  });

  test('an unfetched tag starts at the newest tag below it, never above it', () => {
    expect(tagsBelow(TAGS, '31.26.0')[0]).toBe('v31.25.0');
  });

  test('a version below every tag, or no tags, is none', () => {
    expect(tagsBelow(TAGS, '1.0.0')).toEqual([]);
    expect(tagsBelow([], '31.25.0')).toEqual([]);
  });
});
