// The app half of "which `meta` keys may a problem document carry": the key rule, the all-or-nothing
// refusal and the one table both `defineError` and `@ultimat3/http`'s `registerProblemMeta` write.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  declaredProblemMeta,
  metaKeyRefusal,
  problemMetaRefusal,
  recordProblemMeta,
  resetDeclaredProblemMeta,
} from './problem-meta-declared';

afterEach(resetDeclaredProblemMeta);

describe('unit · problem-meta-declared', () => {
  test('a key is spelled like a source key, and the top-level names are refused', () => {
    expect(metaKeyRefusal('sessionId')).toBeUndefined();
    expect(metaKeyRefusal('$ref_1')).toBeUndefined();
    expect(metaKeyRefusal('1st')).toContain('is not a meta key');
    expect(metaKeyRefusal(7)).toContain('is not a meta key');
    expect(metaKeyRefusal('issues')).toContain('top level');
    expect(metaKeyRefusal('issuesTruncated')).toContain('top level');
    expect(metaKeyRefusal('__proto__')).toContain('not a key a document may carry');
  });

  test('a refusal names the first bad key, an empty list, or a second different list', () => {
    expect(problemMetaRefusal('X_A', [])).toContain('the key list is empty');
    expect(problemMetaRefusal('X_A', ['ok', 'issues'])).toContain('top level');
    expect(problemMetaRefusal('X_A', ['ok'])).toBeUndefined();
    recordProblemMeta('X_A', ['ok']);
    expect(problemMetaRefusal('X_A', ['ok'])).toBeUndefined();
    expect(problemMetaRefusal('X_A', ['other'])).toBe('already declared as [ok] by this app');
  });

  test('the table answers a copy of what was recorded, and a reset forgets it', () => {
    const keys = ['sessionId'];
    recordProblemMeta('X_A', keys);
    keys.push('state');
    expect(declaredProblemMeta('X_A')).toEqual(['sessionId']);
    expect(declaredProblemMeta('toString')).toBeUndefined();
    resetDeclaredProblemMeta();
    expect(declaredProblemMeta('X_A')).toBeUndefined();
  });
});
