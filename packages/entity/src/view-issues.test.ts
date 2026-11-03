// Single responsibility: a `$view` refusal addressed per KEY — a path, a rule from the column's
// fact and the column's own sentence — so a form binds it to the field. WHY: a view is the
// action input `posts.$input.pick()` would have been, and an unbound refusal is a form that says
// "something is wrong" beside every control at once.

import { afterAll, describe, expect, test } from 'bun:test';
import type { StandardIssue } from '@ultimat3/schema';
import { integer, text, uuid } from './columns';
import { entity } from './entity';
import { enumerated } from './enum-column';
import { clearRegistry } from './registry';

const posts = entity('view_issue_posts', {
  columns: {
    id: uuid().primaryKey(),
    title: text({ max: 5 }),
    status: enumerated(['draft', 'live']),
    likeCount: integer(),
  },
});

const Input = posts.$view(['title', 'status', 'likeCount']);

function issuesOf(value: unknown): readonly StandardIssue[] {
  const result = Input['~standard'].validate(value);
  if (result instanceof Promise) return expect.unreachable('a view validates synchronously');
  return result.issues ?? [];
}

afterAll(() => {
  clearRegistry();
});

describe('$view refusals, one issue per key', () => {
  test('an over-long text is string.max at its own path, in the column’s sentence', () => {
    const [issue] = issuesOf({ title: 'too long', status: 'draft', likeCount: 1 });
    expect(issue).toEqual({
      path: ['title'],
      message: 'expected at most 5 characters, got 8',
      rule: 'string.max',
      params: { max: 5 },
    });
  });

  test('every refused key reports, each at its own path', () => {
    const issues = issuesOf({ title: 'too long', status: 'gone', likeCount: 'x' });
    expect(issues.map((issue) => [issue.path, issue.rule])).toEqual([
      [['title'], 'string.max'],
      [['status'], 'enum'],
      [['likeCount'], 'type'],
    ]);
    expect(issues[1]?.params).toEqual({ values: 'draft | live' });
    expect(issues[2]?.params).toEqual({ type: 'number' });
  });

  test('a missing required key is `required` at its path', () => {
    const [issue] = issuesOf({ status: 'draft', likeCount: 1 });
    expect(issue).toMatchObject({ path: ['title'], rule: 'required', message: 'is required' });
  });

  test('a value that is not an object is `type` at the root', () => {
    const [issue] = issuesOf('a post');
    expect(issue).toMatchObject({ path: [], rule: 'type', params: { type: 'object' } });
  });

  test('a valid value still projects', () => {
    const result = Input['~standard'].validate({ title: 'ok', status: 'live', likeCount: 2 });
    expect(result).toEqual({ value: { title: 'ok', status: 'live', likeCount: 2 } });
  });
});
