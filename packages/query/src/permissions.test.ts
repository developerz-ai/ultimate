// The read half of the compliance defect: matching a grant against `capability` reads a
// composite policy's LABEL — `or(feed:read, org:administer)` — which equals no permission string,
// so every non-trivially-guarded read reported its permissions as unenforced.

import { describe, expect, test } from 'bun:test';
import { and, can, not, or } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import type { QueryPolicy } from './policy-gate';
import { policyCapability, policyPermissions } from './policy-gate';
import { query } from './query';
import { from } from './source';

interface Post {
  readonly id: string;
}

const guarded = (policy: QueryPolicy) =>
  query({
    input: t.object({ orgId: t.string }),
    policy,
    sql: () => from<Post>('posts', []),
  }).named('orgFeed');

describe('the query descriptor carries the flattened permissions', () => {
  test('a composite publishes both halves, and only one of them is matchable', () => {
    const descriptor = guarded(or(can('feed:read'), can('org:administer'))).describe();
    expect(descriptor.capability).toContain('or(');
    expect(descriptor.permissions).toEqual(['feed:read', 'org:administer']);
  });

  test('a bare permission agrees with its own label, which is why the bug hid', () => {
    const descriptor = guarded(can('feed:read')).describe();
    expect(descriptor.capability).toBe('feed:read');
    expect(descriptor.permissions).toEqual(['feed:read']);
  });

  test('nesting flattens and a repeat is one entry', () => {
    expect(policyPermissions(and(or(can('a:read'), can('b:read')), can('a:read')))).toEqual([
      'a:read',
      'b:read',
    ]);
  });

  test('a not() clause still contributes — the grant participates in the decision', () => {
    expect(policyPermissions(not(can('order:internal')))).toEqual(['order:internal']);
  });

  test('capability stays the display label', () => {
    const policy = or(can('feed:read'), can('org:administer'));
    expect(policyCapability(policy)).toBe(policy.label);
  });
});
