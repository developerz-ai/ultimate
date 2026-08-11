// The open set decides what the first paint looks like, and `exclusive` is the case where the
// browser would otherwise decide for us.

import { describe, expect, test } from 'bun:test';
import { UI_ERROR_CODES, UiError } from '../errors';
import { accordionOpenIds } from './accordion-view';

const sections = [
  { id: 'one', defaultOpen: true },
  { id: 'two' },
  { id: 'three', defaultOpen: true },
];

describe('accordionOpenIds', () => {
  test('opens every section that asked, by default', () => {
    expect([...accordionOpenIds(sections)]).toEqual(['one', 'three']);
  });

  test('exclusive keeps the first and closes the rest', () => {
    expect([...accordionOpenIds(sections, true)]).toEqual(['one']);
  });

  test('nothing is open when nothing asked', () => {
    expect(accordionOpenIds([{ id: 'a' }, { id: 'b' }], true).size).toBe(0);
  });

  test('a duplicate id is a UiError — ids become element ids', () => {
    expect(() => accordionOpenIds([{ id: 'a' }, { id: 'a' }])).toThrow(UiError);
    try {
      accordionOpenIds([{ id: 'a' }, { id: 'a' }]);
    } catch (error) {
      expect((error as UiError).code).toBe(UI_ERROR_CODES.invalidValue);
      expect((error as UiError).cause).toContain('unique item id');
    }
  });
});
