// `definePolicy` is sugar over `can()`. policy-args.test.ts proves it forwards the unified
// predicate args; this file covers the branches unique to `define.ts` itself: no `check` at
// all, a `check` returning a bare boolean, and a `check` returning a full `PolicyDecision`
// (a more specific denial than the shared `deny` key).
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { definePolicy } from './define';
import { evaluate } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import { clearRoles, defineRoles } from './roles';
import { testActor } from './test-kit';

interface PostInput {
  readonly postId: string;
}

const input: PostInput = { postId: 'p1' };

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:publish'] as const);
  defineRoles({ editor: { grants: ['post:read', 'post:publish'] } });
});

afterAll(() => {
  clearPermissions();
  clearRoles();
});

const editor = testActor('editor', { roles: ['editor'] }).actor;
const viewer = testActor('viewer', { roles: [] }).actor;

describe('definePolicy()', () => {
  test('with no check, it is identical to can(permission): permission alone decides', () => {
    const policy = definePolicy<PostInput>('post:read', { deny: 'errors.policyDenied' });
    expect(evaluate(policy, { input, actor: editor }).allowed).toBe(true);
    const result = evaluate(policy, { input, actor: viewer });
    expect(result.allowed).toBe(false);
    expect(result.decision.allowed ? '' : result.decision.reason).toBe('actor lacks post:read');
  });

  test('check returning true allows', () => {
    const policy = definePolicy<PostInput>('post:read', {
      deny: 'errors.policyDenied',
      check: () => true,
    });
    expect(evaluate(policy, { input, actor: editor }).allowed).toBe(true);
  });

  test('check returning false denies with the declared `deny` key as the reason', () => {
    const policy = definePolicy<PostInput>('post:publish', {
      deny: 'errors.notPublishable',
      check: () => false,
    });
    const result = evaluate(policy, { input, actor: editor });
    expect(result.allowed).toBe(false);
    expect(result.decision.allowed ? '' : result.decision.reason).toBe('errors.notPublishable');
  });

  test('check returning a full PolicyDecision overrides the declared `deny` key', () => {
    const policy = definePolicy<PostInput>('post:publish', {
      deny: 'errors.notPublishable',
      check: () => ({ allowed: false, reason: 'errors.moreSpecific', code: 'X_FORBIDDEN' }),
    });
    const result = evaluate(policy, { input, actor: editor });
    expect(result.allowed).toBe(false);
    expect(result.decision.allowed ? '' : result.decision.reason).toBe('errors.moreSpecific');
  });

  test('an actor lacking the permission never reaches check() at all', () => {
    let checkRan = false;
    const policy = definePolicy<PostInput>('post:publish', {
      deny: 'errors.notPublishable',
      check: () => {
        checkRan = true;
        return true;
      },
    });
    const result = evaluate(policy, { input, actor: viewer });
    expect(result.allowed).toBe(false);
    expect(checkRan).toBe(false);
  });
});
