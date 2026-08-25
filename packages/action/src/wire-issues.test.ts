// The one reader of an `issues` member off a problem document. It is a wire value, so every case
// here is a body a hostile or broken server can send — and none of them may throw inside the
// failure path, and none may bind an issue to the wrong place.

import { describe, expect, test } from 'bun:test';
import { issuesFromWire, MAX_WIRE_ISSUES } from './wire-issues';

const issue = (path: string, message: string): Record<string, unknown> => ({
  path,
  expected: message,
  received: '',
  message,
});

describe('issuesFromWire', () => {
  test('reads the shape @ultimat3/schema mints, member for member', () => {
    expect(issuesFromWire([issue('items[0].price', 'expected a number')])).toEqual([
      {
        path: 'items[0].price',
        expected: 'expected a number',
        received: '',
        message: 'expected a number',
      },
    ]);
  });

  test('keeps a pathless issue — the form is a place an issue can land', () => {
    expect(issuesFromWire([issue('', 'at least one item')])?.[0]?.path).toBe('');
  });

  test('defaults the two advisory members, which cannot mis-route anything', () => {
    expect(issuesFromWire([{ path: 'title', message: 'too short' }])).toEqual([
      { path: 'title', expected: '', received: '', message: 'too short' },
    ]);
  });

  test('carries only the four declared members — a foreign field never rides along', () => {
    const carried = issuesFromWire([
      { ...issue('title', 'too short'), value: 'hunter2', code: 'x' },
    ]);
    expect(carried?.[0]).toEqual({
      path: 'title',
      expected: 'too short',
      received: '',
      message: 'too short',
    });
    expect(Object.keys(carried?.[0] ?? {})).toEqual(['path', 'expected', 'received', 'message']);
  });

  test('one malformed entry refuses the WHOLE list, so the flattened cause is still the answer', () => {
    expect(issuesFromWire([issue('title', 'too short'), { path: 'slug' }])).toBeUndefined();
    expect(
      issuesFromWire([issue('title', 'too short'), { path: 1, message: 'x' }]),
    ).toBeUndefined();
    expect(issuesFromWire([issue('title', 'too short'), 'not an object'])).toBeUndefined();
    expect(issuesFromWire([issue('title', '')])).toBeUndefined();
  });

  test('a body carrying no list at all is not a failure', () => {
    for (const value of [undefined, null, {}, 'issues', 42, []]) {
      expect(issuesFromWire(value)).toBeUndefined();
    }
  });

  test('refuses a list longer than a form has fields — the entries are rendered into a DOM', () => {
    const many = (count: number): unknown[] =>
      Array.from({ length: count }, (_, index) => issue(`f${index}`, 'bad'));
    expect(issuesFromWire(many(MAX_WIRE_ISSUES))).toHaveLength(MAX_WIRE_ISSUES);
    expect(issuesFromWire(many(MAX_WIRE_ISSUES + 1))).toBeUndefined();
  });

  test('a member that fights being read is refused, never thrown out of', () => {
    const hostile = {
      path: 'title',
      get message(): string {
        throw new TypeError('nope');
      },
    };
    expect(() => issuesFromWire([hostile])).not.toThrow();
    expect(issuesFromWire([hostile])).toBeUndefined();
  });
});
