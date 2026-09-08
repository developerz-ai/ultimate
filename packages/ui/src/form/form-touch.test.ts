// The two states an "unsaved changes" guard and a blur-time hint both read. Every case here is one
// where the obvious implementation prompts the user about work they did not do.

import { describe, expect, test } from 'bun:test';
import { isFormDirty, markDirty, markTouched, NO_FORM_TOUCH, sameFieldValue } from './form-touch';

describe('sameFieldValue', () => {
  test('an empty control and an absent baseline are the same thing to the person typing', () => {
    // Typing a character into a new record's field and deleting it again is not a change, and
    // `Object.is('', undefined)` alone turns every abandoned keystroke into a leave prompt.
    expect(sameFieldValue('', undefined)).toBe(true);
    expect(sameFieldValue(null, '')).toBe(true);
  });

  test('0 and false are values, not blanks', () => {
    expect(sameFieldValue(0, undefined)).toBe(false);
    expect(sameFieldValue(false, '')).toBe(false);
    expect(sameFieldValue(0, 0)).toBe(true);
  });

  test('two different values are different', () => {
    expect(sameFieldValue('a', 'b')).toBe(false);
  });
});

describe('markTouched', () => {
  test('records the field and answers the same state for a repeat', () => {
    const once = markTouched(NO_FORM_TOUCH, 'title');
    expect([...once.touched]).toEqual(['title']);
    expect(markTouched(once, 'title')).toBe(once);
  });

  test('leaves dirty alone — visiting a field is not editing it', () => {
    expect(isFormDirty(markTouched(NO_FORM_TOUCH, 'title'))).toBe(false);
  });
});

describe('markDirty', () => {
  test('is two-way: typing a character and deleting it leaves the form clean', () => {
    const dirty = markDirty(NO_FORM_TOUCH, 'title', true);
    expect(isFormDirty(dirty)).toBe(true);
    expect(isFormDirty(markDirty(dirty, 'title', false))).toBe(false);
  });

  test('no change is the same state, by identity', () => {
    const dirty = markDirty(NO_FORM_TOUCH, 'title', true);
    expect(markDirty(dirty, 'title', true)).toBe(dirty);
    expect(markDirty(NO_FORM_TOUCH, 'title', false)).toBe(NO_FORM_TOUCH);
  });

  test('one clean field does not clean the rest', () => {
    const both = markDirty(markDirty(NO_FORM_TOUCH, 'title', true), 'body', true);
    expect([...markDirty(both, 'title', false).dirty]).toEqual(['body']);
  });
});
