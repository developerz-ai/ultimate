import { beforeEach, describe, expect, test } from 'bun:test';
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
