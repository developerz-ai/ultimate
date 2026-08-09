// One declared predicate signature, proved: `{ input, actor, row, ctx }` is what every
// predicate sees, whatever surface called it. These tests are the fence around the drift
// that used to let a row-level rule receive a different shape from an input-level one.

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { definePolicy } from './define';
import { evaluate, explain, renderTrace } from './evaluate';
import { clearPermissions, definePermissions, type KnownPermission } from './permissions';
import { and, can, not, or } from './policy';
import { clearRoles, defineRoles } from './roles';
import { testActor } from './test-kit';

interface PostInput {
  readonly postId: string;
}

interface PostRow {
  readonly id: string;
  readonly authorId: string;
  readonly secret: string;
}

const input: PostInput = { postId: 'p1' };
const row: PostRow = { id: 'row-42', authorId: 'owner', secret: 'nuclear-codes' };

beforeEach(() => {
  clearPermissions();
  clearRoles();
  definePermissions(['post:read', 'post:publish', 'post:delete', 'org:admin'] as const);
  defineRoles({
    editor: { grants: ['post:publish', 'post:read'] },
    root: { grants: ['*'] },
  });
});

const owner = testActor('owner', { roles: ['root'] }).actor;
const editor = testActor('editor', { roles: ['editor'] }).actor;
const root = testActor('root', { roles: ['root'] }).actor;

// The permission and role registries are process-global by design — one app, one set. A test
// file that leaves them populated makes an unrelated package's `can()` throw
// X_PERMISSION_UNKNOWN, so this file must hand the process back the way it found it.
afterAll(() => {
  clearPermissions();
  clearRoles();
});

describe('the unified predicate args', () => {
  const ownsRow = () =>
    can<PostInput, PostRow>('post:publish', ({ actor, row: subject }) => {
      if (subject === null) return false;
      return subject.authorId === actor?.id;
    });

  test('a row rule decides on the row the surface supplied', () => {
    expect(evaluate(ownsRow(), { input, actor: owner, row }).allowed).toBe(true);
    expect(evaluate(ownsRow(), { input, actor: editor, row }).allowed).toBe(false);
  });

  test('the same rule sees `row === null` when the surface supplies none', () => {
    let seen: PostRow | null | 'never ran' = 'never ran';
    const policy = can<PostInput, PostRow>('post:publish', (args) => {
      seen = args.row;
      return true;
    });
    expect(evaluate(policy, { input, actor: owner }).allowed).toBe(true);
    expect(seen).toBeNull();
  });

  test('an explicit `row: null` and an omitted row reach the predicate identically', () => {
    const policy = ownsRow();
    expect(evaluate(policy, { input, actor: owner, row: null }).allowed).toBe(
      evaluate(policy, { input, actor: owner }).allowed,
    );
  });

  test('an input-only caller is unaffected: no `row` argument, no behaviour change', () => {
    const byInput = can<PostInput>('post:read', ({ input: given }) => given.postId === 'p1');
    expect(evaluate(byInput, { input, actor: editor }).allowed).toBe(true);
    expect(evaluate(byInput, { input: { postId: 'p2' }, actor: editor }).allowed).toBe(false);
  });

  test('definePolicy takes the same args, so a row rule is written once', () => {
    const publish = definePolicy<PostInput, PostRow>('post:publish', {
      deny: 'errors.notTheAuthor',
      check: ({ actor, row: subject }) => subject !== null && subject.authorId === actor?.id,
    });
    expect(evaluate(publish, { input, actor: owner, row }).allowed).toBe(true);
    const refused = evaluate(publish, { input, actor: owner });
    expect(refused.decision.allowed ? '' : refused.decision.reason).toBe('errors.notTheAuthor');
  });
});

describe('combinators forward the row', () => {
  test('and/or/not hand every child the very same args object', () => {
    const seen: (PostRow | null)[] = [];
    const spy = (permission: KnownPermission, verdict: boolean) =>
      can<PostInput, PostRow>(permission, (args) => {
        seen.push(args.row);
        return verdict;
      });

    // `and` runs children until one denies and `or` until one allows, so this is the one
    // arrangement in which all four clauses actually execute.
    const policy = and(
      spy('post:read', true),
      or(spy('post:publish', false), spy('post:delete', true)),
      not(spy('org:admin', false)),
    );

    expect(evaluate(policy, { input, actor: root, row }).allowed).toBe(true);
    expect(seen).toHaveLength(4);
    // Identity, not deep equality: a clause that rebuilt the args would be the old bug again.
    expect(seen.every((entry) => entry === row)).toBe(true);
  });
});

describe('reasons stay safe to log', () => {
  test('a denial decided with a row present names no field of that row', () => {
    const policy = and(
      can<PostInput, PostRow>('post:publish'),
      can<PostInput, PostRow>(
        'post:read',
        ({ actor, row: subject }) => subject?.authorId === actor?.id,
      ),
    );
    const result = evaluate(policy, { input, actor: editor, row });
    expect(result.allowed).toBe(false);
    const reason = result.decision.allowed ? '' : result.decision.reason;
    expect(reason).toBe('post:read predicate returned false');

    const rendered = [reason, explain(result), renderTrace(result), JSON.stringify(result)].join(
      '\n',
    );
    expect(rendered).not.toContain(row.id);
    expect(rendered).not.toContain(row.secret);
  });
});
