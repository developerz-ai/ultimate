// The rule that decides where a rejection is READ. Every case here is a way an app loses an error
// silently: an undeclared path, a near-miss path, a second issue on one field, a translator that
// answers nothing.

import { describe, expect, test } from 'bun:test';
import type { FormIssue } from './form-issue';
import { distributeIssues, errorOf, messagesOf } from './form-state';

const issue = (path: string, message: string): FormIssue => ({ path, message, code: undefined });

/** The app's wording, keyed off the path — what a real `messageFor` does with `t()`. */
const shout = (found: FormIssue): string => `«${found.path}:${found.message}»`;

describe('distributeIssues', () => {
  test('binds an issue to the field that declared its exact path', () => {
    const errors = distributeIssues(
      [issue('items[2].price', 'expected number')],
      new Set(['items[2].price']),
      shout,
    );
    expect(errorOf(errors, 'items[2].price')).toBe('«items[2].price:expected number»');
    expect(errors.formErrors).toEqual([]);
  });

  test('an issue whose path no field declared is surfaced at the form, never dropped', () => {
    const errors = distributeIssues([issue('slug', 'already taken')], new Set(['title']), shout);
    expect(errors.fieldErrors.size).toBe(0);
    expect(errors.formErrors).toEqual(['«slug:already taken»']);
  });

  test('a near miss goes to the form, never to a neighbouring control', () => {
    const errors = distributeIssues(
      [issue('items', 'at least one')],
      new Set(['items[0].price']),
      shout,
    );
    expect(messagesOf(errors, 'items[0].price')).toEqual([]);
    expect(errors.formErrors).toEqual(['«items:at least one»']);
  });

  test('a pathless issue is the form’s', () => {
    const errors = distributeIssues([issue('', 'policy denied')], new Set(['title']), shout);
    expect(errors.formErrors).toEqual(['«:policy denied»']);
  });

  test('two issues on one field both survive; the slot renders the first', () => {
    const errors = distributeIssues(
      [issue('title', 'too short'), issue('title', 'reserved')],
      new Set(['title']),
      shout,
    );
    expect(messagesOf(errors, 'title')).toEqual(['«title:too short»', '«title:reserved»']);
    expect(errorOf(errors, 'title')).toBe('«title:too short»');
  });

  test('a translator that answers nothing falls back to the diagnostic text, never to silence', () => {
    const errors = distributeIssues([issue('title', 'too short')], new Set(['title']), () => '   ');
    expect(errorOf(errors, 'title')).toBe('too short');
  });

  test('a translator that throws still leaves the user something to read', () => {
    const errors = distributeIssues([issue('title', 'too short')], new Set(['title']), () => {
      throw new TypeError('catalog missing');
    });
    expect(errorOf(errors, 'title')).toBe('too short');
  });

  test('a field with no issue answers undefined, so Field stays valid', () => {
    const errors = distributeIssues([], new Set(['title']), shout);
    expect(errorOf(errors, 'title')).toBeUndefined();
  });
});
