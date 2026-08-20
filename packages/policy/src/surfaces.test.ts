import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearPermissions, definePermissions } from './permissions';
import { can } from './policy';
import { clearRoles, defineRoles } from './roles';
import {
  assertAllowed,
  enforce,
  enforceHttp,
  enforceJob,
  enforceLive,
  enforceMcp,
  type Surface,
} from './surfaces';
import { testActor } from './test-kit';

interface Input {
  readonly postId: string;
}

const input: Input = { postId: 'p1' };

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:publish'] as const);
  defineRoles({ editor: { grants: ['post:publish'] } });
});

const policy = can<Input>('post:publish');
const editor = testActor('editor', { roles: ['editor'] }).actor;
const guest = testActor('guest', { roles: [] }).actor;

// The permission and role registries are process-global by design — one app, one set. A test
// file that leaves them populated makes an unrelated package's `can()` throw
// X_PERMISSION_UNKNOWN, so this file must hand the process back the way it found it.
afterAll(() => {
  clearPermissions();
  clearRoles();
});

describe('one policy, four surfaces', () => {
  test('an allowed actor gets undefined everywhere — the call proceeds', () => {
    const args = { input, actor: editor };
    expect(enforceHttp(policy, args)).toBeUndefined();
    expect(enforceLive(policy, args)).toBeUndefined();
    expect(enforceJob(policy, args)).toBeUndefined();
    expect(enforceMcp(policy, args)).toBeUndefined();
  });

  test('http maps a denial to a 403 problem document', () => {
    const denial = enforceHttp(policy, { input, actor: guest });
    expect(denial).toEqual({
      surface: 'http',
      status: 403,
      problem: {
        title: 'policy denied this actor',
        status: 403,
        detail: 'actor lacks post:publish',
        code: 'X_FORBIDDEN',
      },
    });
  });

  test('live maps a denial to a close frame the client will not retry', () => {
    expect(enforceLive(policy, { input, actor: guest })).toEqual({
      surface: 'live',
      close: 4403,
      code: 'X_FORBIDDEN',
      reason: 'actor lacks post:publish',
    });
  });

  test('job maps a denial to a non-retryable failure', () => {
    const denial = enforceJob(policy, { input, actor: guest });
    expect(denial?.outcome).toBe('failed');
    expect(denial?.retryable).toBe(false);
    expect(denial?.reason).toBe('actor lacks post:publish');
  });

  test('mcp maps a denial to a tool error an agent can read', () => {
    const denial = enforceMcp(policy, { input, actor: guest });
    expect(denial?.isError).toBe(true);
    expect(denial?.content[0]?.text).toBe('X_FORBIDDEN: actor lacks post:publish');
  });

  test('an anonymous caller is denied identically on every surface', () => {
    const surfaces: readonly Surface[] = ['http', 'live', 'job', 'mcp'];
    const denials = surfaces.map((surface) => enforce(surface, policy, { input, actor: null }));
    expect(denials.every((denial) => denial !== undefined)).toBe(true);
    expect(denials.map((denial) => denial?.surface)).toEqual([...surfaces]);
  });
});

describe('assertAllowed', () => {
  test('returns the evaluation when allowed', () => {
    expect(assertAllowed(policy, { input, actor: editor }).allowed).toBe(true);
  });

  test('throws X_FORBIDDEN carrying the same reason the adapters report', () => {
    expect(() => assertAllowed(policy, { input, actor: guest })).toThrow(
      /X_FORBIDDEN|actor lacks post:publish/,
    );
  });
});
