// A compliance report reads real grants as dead when it matches on `capability`: a composite
// policy's label is `and(post:publish, org:administer)`, a sentence that equals no permission
// string, so every non-trivial rule in a real app reported its permissions as unenforced.

import { describe, expect, test } from 'bun:test';
import { and, can, not, or } from '@ultimat3/policy';
import { t } from '@ultimat3/schema';
import { action } from './action';
import type { ActionPolicy } from './policy-gate';
import { policyCapability, policyPermissions } from './policy-gate';

const Input = t.object({ id: t.string });
const Output = t.object({ ok: t.boolean });

const guarded = (policy: ActionPolicy) =>
  action({ input: Input, output: Output, policy, handle: () => ({ ok: true }) }).named(
    'publishPost',
  );

describe('the descriptor carries the flattened permissions, not only the label', () => {
  test('a composite policy publishes both halves, and only one of them is matchable', () => {
    const descriptor = guarded(and(can('post:publish'), can('org:administer'))).describe();
    // The label is a sentence — this is exactly what `x policy list` was matching on.
    expect(descriptor.capability).toContain('and(');
    expect(descriptor.permissions).toEqual(['org:administer', 'post:publish']);
  });

  test('a bare permission agrees with its own label, which is why the bug hid', () => {
    const descriptor = guarded(can('post:publish')).describe();
    expect(descriptor.capability).toBe('post:publish');
    expect(descriptor.permissions).toEqual(['post:publish']);
  });

  test('nesting flattens, and a repeat is one entry', () => {
    const policy = or(and(can('a:read'), can('b:write')), can('a:read'));
    expect(policyPermissions(policy)).toEqual(['a:read', 'b:write']);
  });

  test('a not() clause still contributes — the grant participates in the decision', () => {
    expect(policyPermissions(not(can('order:internal')))).toEqual(['order:internal']);
  });

  test('capability stays the display label and is never replaced by the list', () => {
    const policy = and(can('post:publish'), can('org:administer'));
    expect(policyCapability(policy)).toBe(policy.label);
  });
});
