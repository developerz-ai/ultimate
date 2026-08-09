import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearPermissions, definePermissions } from './permissions';
import { and, can } from './policy';
import { clearRoles, defineRoles } from './roles';
import { policyMatrix, testActor } from './test-kit';

interface Input {
  readonly postId: string;
  readonly ownerId: string;
}

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:publish'] as const);
  defineRoles({
    viewer: { grants: ['post:read'] },
    editor: { grants: ['post:publish'], inherits: ['viewer'] },
    root: { grants: ['*'] },
  });
});

const publishOwnPost = () =>
  and(
    can<Input>('post:publish'),
    can<Input>('post:read', (args) => args.actor?.id === args.input.ownerId),
  );

// The permission and role registries are process-global by design — one app, one set. A test
// file that leaves them populated makes an unrelated package's `can()` throw
// X_PERMISSION_UNKNOWN, so this file must hand the process back the way it found it.
afterAll(() => {
  clearPermissions();
  clearRoles();
});

describe('policyMatrix', () => {
  const actors = () => [
    testActor('owner', { roles: ['editor'] }),
    testActor('editor', { roles: ['editor'] }),
    testActor('viewer', { roles: ['viewer'] }),
    testActor('root', { roles: ['root'] }),
    { name: 'anonymous', actor: null },
  ];

  test('produces an assert-ready allow/deny verdict per actor', () => {
    const matrix = policyMatrix(publishOwnPost(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: actors(),
    });

    // `root` holds `*`, yet is still denied: a wildcard grant satisfies the permission
    // clause but not the row-level predicate. That asymmetry is the reason a policy has
    // both, and a matrix is how you see it.
    expect(matrix.verdicts).toEqual({
      owner: true,
      editor: false,
      viewer: false,
      root: false,
      anonymous: false,
    });
    expect(matrix.allowedFor('owner')).toBe(true);
    expect(matrix.allowedFor('nobody')).toBe(false);
  });

  test('every denial carries a reason and the clause that decided', () => {
    const matrix = policyMatrix(publishOwnPost(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: actors(),
    });
    for (const row of matrix.rows) {
      if (row.allowed) continue;
      expect(row.reason, `${row.actor} denied with no reason`).toBeTruthy();
      expect(row.deciding, `${row.actor} denied with no deciding clause`).toBeTruthy();
    }
    expect(matrix.rows.find((row) => row.actor === 'viewer')?.reason).toBe(
      'actor lacks post:publish',
    );
  });

  test('forwards `row`, so a row-level rule is not reported as denying everyone', () => {
    const ownsRow = can<Input, { readonly authorId: string }>(
      'post:read',
      ({ actor, row }) => row?.authorId === actor?.id,
    );
    const base = { input: { postId: 'p1', ownerId: 'owner' }, actors: actors() };

    // No row: the rule correctly denies — `row` is `null`, not `undefined`.
    expect(policyMatrix(ownsRow, base).allowedFor('owner')).toBe(false);
    // With a row: the same rule allows its author. A matrix that dropped `row` could not
    // tell these two tables apart, and would report the second one wrong.
    expect(policyMatrix(ownsRow, { ...base, row: { authorId: 'owner' } }).allowedFor('owner')).toBe(
      true,
    );
  });

  test('toTable() renders one line per actor for a snapshot', () => {
    const matrix = policyMatrix(publishOwnPost(), {
      input: { postId: 'p1', ownerId: 'owner' },
      actors: actors(),
    });
    const lines = matrix.toTable().split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toStartWith('owner');
    expect(lines[0]).toContain('allow');
    expect(lines[2]).toContain('deny');
  });
});
