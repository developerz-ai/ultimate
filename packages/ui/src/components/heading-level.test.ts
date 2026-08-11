// The heading mapping is the one place a level becomes an element, so it is the one place the
// outline can break.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES } from '../errors';
import { HEADING_LEVELS, headingTag, nextHeadingLevel } from './heading-level';

describe('headingTag', () => {
  test('maps every declared level to its element', () => {
    expect(HEADING_LEVELS.map(headingTag)).toEqual(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
  });

  test('a level off the scale is X_UI_INVALID_VALUE with a fix', () => {
    for (const bad of [0, 7, -1, 1.5]) {
      try {
        headingTag(bad as (typeof HEADING_LEVELS)[number]);
        throw new Error(`expected a throw for ${bad}`);
      } catch (error) {
        const err = error as { code?: string; fix?: string };
        expect(err.code).toBe(UI_ERROR_CODES.invalidValue);
        expect(err.fix).toBeTruthy();
      }
    }
  });
});

describe('nextHeadingLevel', () => {
  test('descends one level per nesting step', () => {
    expect(HEADING_LEVELS.map(nextHeadingLevel)).toEqual([2, 3, 4, 5, 6, 6]);
  });

  test('clamps at 6 instead of inventing an h7', () => {
    expect(nextHeadingLevel(nextHeadingLevel(6))).toBe(6);
    expect(headingTag(nextHeadingLevel(6))).toBe('h6');
  });
});
