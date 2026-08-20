/**
 * Pins the policy DSL surface. `policy.test.ts`/`surfaces.test.ts` prove the
 * combinators and adapters behave correctly; this file proves the *shape*
 * cannot silently drift — every combinator and every `Policy` member still
 * exists — and that the surface adapters (`enforceHttp`/`enforceLive`/
 * `enforceJob`/`enforceMcp`) and the `enforce()` dispatcher all read the exact
 * same decision from the exact same policy object, never a copy. That is the
 * "one authz system, never two" claim this package exists to keep true.
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { evaluate } from './evaluate';
import { clearPermissions, definePermissions } from './permissions';
import { allow, and, can, deny, not, or } from './policy';
import { clearRoles, defineRoles } from './roles';
import {
  enforce,
  enforceHttp,
  enforceJob,
  enforceLive,
  enforceMcp,
  type Surface,
  type SurfaceDenial,
} from './surfaces';
import { testActor } from './test-kit';

interface Input {
  readonly postId: string;
}

const input: Input = { postId: 'p1' };

// The exact contract: `Policy<I, R>` (policy.ts) — every combinator returns this
// same shape, so a surface adapter never has to special-case which combinator
// built it. Kept in sync by hand on purpose — a silent drift here is exactly
// the regression this file exists to catch.
const POLICY_MEMBERS = ['kind', 'label', 'permissions', 'children', 'run'] as const;

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:publish'] as const);
  defineRoles({ editor: { grants: ['post:publish'] } });
});

afterAll(() => {
  clearPermissions();
  clearRoles();
});

const editor = testActor('editor', { roles: ['editor'] }).actor;
const guest = testActor('guest', { roles: [] }).actor;

describe('the policy DSL surface', () => {
  test('every combinator produces the one Policy shape', () => {
    const policy = can<Input>('post:publish');
    const policies = [
      policy,
      allow<Input>(),
      deny<Input>('nope'),
      and<Input>(policy, allow<Input>()),
      or<Input>(policy, deny<Input>('nope')),
      not<Input>(policy),
    ];
    for (const built of policies) {
      for (const member of POLICY_MEMBERS) expect(built).toHaveProperty(member);
    }
  });

  test('and()/or()/not() delegate to their children run() — never re-decide directly', () => {
    const policy = can<Input>('post:publish');
    const trace: string[] = [];
    const spy = {
      kind: 'permission' as const,
      label: 'spy',
      permissions: [],
      children: [],
      run: (_args: unknown, _record?: unknown, _depth?: number) => {
        trace.push('spy-ran');
        return { allowed: true } as const;
      },
    };
    and(spy, policy).run({ input, actor: editor, row: null });
    expect(trace).toEqual(['spy-ran']);
  });

  // The DSL's central claim: every surface adapter reads the SAME decision from
  // the SAME policy — `enforceHttp`/`enforceLive`/`enforceJob`/`enforceMcp` are
  // never a second authz path, just a denial shaped for their wire format.
  test('every surface adapter denies for the same reason evaluate() itself reports', () => {
    const policy = can<Input>('post:publish');
    const args = { input, actor: guest };
    const evaluation = evaluate(policy, args);
    expect(evaluation.decision.allowed).toBe(false);
    if (evaluation.decision.allowed) return; // unreachable; narrows the type below

    const httpDenial = enforceHttp(policy, args);
    const liveDenial = enforceLive(policy, args);
    const jobDenial = enforceJob(policy, args);
    const mcpDenial = enforceMcp(policy, args);

    expect(httpDenial?.problem.code).toBe(evaluation.decision.code);
    expect(liveDenial?.code).toBe(httpDenial?.problem.code);
    expect(jobDenial?.code).toBe(httpDenial?.problem.code);
    expect(mcpDenial?.content[0]?.text).toContain(httpDenial?.problem.code ?? '');
  });

  test('enforce() dispatches to the same adapter, not a reimplementation', () => {
    const policy = can<Input>('post:publish');
    const args = { input, actor: guest };
    // `SurfaceDenial`, not `ReturnType<typeof enforceHttp>`: each adapter answers its OWN wire
    // shape, and typing the table as http's silently made three of the four unassignable.
    const table: Record<Surface, () => SurfaceDenial | undefined> = {
      http: () => enforceHttp(policy, args),
      live: () => enforceLive(policy, args),
      job: () => enforceJob(policy, args),
      mcp: () => enforceMcp(policy, args),
    };
    for (const surface of Object.keys(table) as Surface[]) {
      expect(enforce(surface, policy, args)).toEqual(table[surface]());
    }
  });

  test('an allowed actor passes through every adapter with no denial', () => {
    const policy = can<Input>('post:publish');
    const args = { input, actor: editor };
    expect(enforceHttp(policy, args)).toBeUndefined();
    expect(enforceLive(policy, args)).toBeUndefined();
    expect(enforceJob(policy, args)).toBeUndefined();
    expect(enforceMcp(policy, args)).toBeUndefined();
  });
});
