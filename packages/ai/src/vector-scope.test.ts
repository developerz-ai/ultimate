import { describe, expect, test } from 'bun:test';
import { narrowScope, scopeAdmits, UNSCOPED } from './vector-scope';

describe('unit · narrowScope only ever tightens', () => {
  test('a tenant is set once and never changed', () => {
    expect(narrowScope('docs', UNSCOPED, { tenant: 'acme' })).toEqual({ tenant: 'acme' });
    expect(() => narrowScope('docs', { tenant: 'acme' }, { tenant: 'other' })).toThrow();
  });

  test('allow-lists intersect — a derived scope cannot restore a removed value', () => {
    const held = { visibility: ['public', 'internal'] };
    const derived = narrowScope('docs', { allow: held }, { allow: { visibility: ['public'] } });
    expect(derived.allow).toEqual({ visibility: ['public'] });

    const widened = narrowScope('docs', derived, { allow: { visibility: ['internal'] } });
    // Intersection, not replacement: nothing the parent removed comes back.
    expect(widened.allow).toEqual({ visibility: [] });
  });
});

// Every key here is a CALLER's string — an app's metadata field name, chosen by whoever wrote the
// policy. The only contract this path has is `X_VECTOR_SCOPE_WIDENED`, so a prototype-chain read
// that escapes as a bare `TypeError` is the one failure nothing downstream can catch by code.
describe('unit · a caller string is never used as an object key', () => {
  const INHERITED = ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__'];

  test('a metadata key spelling an Object.prototype member narrows like any other', () => {
    for (const key of INHERITED) {
      const derived = narrowScope('docs', UNSCOPED, { allow: { [key]: ['public'] } });
      expect(derived.allow?.[key]).toEqual(['public']);
    }
  });

  test('intersecting on such a key is an intersection, not a TypeError', () => {
    for (const key of INHERITED) {
      const base = narrowScope('docs', UNSCOPED, { allow: { [key]: ['public', 'internal'] } });
      const derived = narrowScope('docs', base, { allow: { [key]: ['internal', 'secret'] } });
      expect(derived.allow?.[key]).toEqual(['internal']);
    }
  });

  test('scopeAdmits reads own properties only, so an inherited member is not a match', () => {
    for (const key of INHERITED) {
      const scope = { allow: { [key]: ['public'] } };
      // The row carries no such metadata field; default deny is the rule.
      expect(scopeAdmits(scope, '', {})).toBe(false);
      expect(scopeAdmits(scope, '', { [key]: 'public' })).toBe(true);
      expect(scopeAdmits(scope, '', { [key]: 'secret' })).toBe(false);
    }
  });
});
