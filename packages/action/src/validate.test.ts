/**
 * `validateInput`/`validateOutput` are the one parse path every surface shares —
 * covered directly here so the two failure modes (bad input, drifted output)
 * stay pinned to their own code and carry the action name and the issue text.
 */

import { describe, expect, test } from 'bun:test';
import { formatIssues, t } from '@ultimat3/schema';
import { InputInvalidError, OutputInvalidError } from './errors';
import { validateInput, validateOutput } from './validate';

const Schema = t.object({ postId: t.uuid, title: t.string.min(1) });

const Nested = t.object({ items: t.array(t.object({ price: t.number })) });

// `schema: Parameters<typeof validateInput>[0]`, never `schema = Schema`: a default parameter
// infers its type from the default, so the helper accepted only `Schema`'s exact shape and the
// nested-path case below could not be passed to it. Derived from the function under test, so it
// cannot drift from what `validateInput` actually accepts.
const refusalOf = async (
  raw: unknown,
  schema: Parameters<typeof validateInput>[0] = Schema,
): Promise<InputInvalidError> => {
  const failure = await validateInput(schema, raw, 'publishPost').catch((error: unknown) => error);
  if (!(failure instanceof InputInvalidError)) {
    return expect.unreachable(`expected an InputInvalidError, got ${typeof failure}`);
  }
  return failure;
};

describe('validateInput', () => {
  test('returns the parsed value for a payload the schema accepts', async () => {
    const raw = { postId: '00000000-0000-4000-8000-0000000000aa', title: 'Hello' };

    const parsed = await validateInput(Schema, raw, 'publishPost');

    expect(parsed).toEqual(raw);
  });

  test('throws InputInvalidError, carrying the action name and the issue text', async () => {
    const failure = await validateInput(
      Schema,
      { postId: 'not-a-uuid', title: '' },
      'publishPost',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(InputInvalidError);
    expect((failure as InputInvalidError).code).toBe('X_INPUT_INVALID');
    expect((failure as InputInvalidError).cause).toContain('publishPost');
    expect((failure as InputInvalidError).cause).toContain('postId');
  });
});

/**
 * The structured channel BESIDE the line, added 2026-08-24. Before it, a client rebuilding a form
 * had the flattened `cause` and nothing else — every app split that string back apart by hand.
 */
describe('validateInput carries the issues, not only the line', () => {
  test('addresses every rejection by path, nested ones included', async () => {
    const failure = await refusalOf({ items: [{ price: 1 }, { price: 'free' }] }, Nested);

    expect(failure.issues?.map((issue) => issue.path)).toEqual(['items[1].price']);
    expect(failure.issues?.[0]?.message.length).toBeGreaterThan(0);
  });

  test('the list is what `meta` carries, so an HTTP surface can find it', async () => {
    const failure = await refusalOf({ postId: 'not-a-uuid', title: '' });

    expect(failure.meta?.['issues']).toBe(failure.issues);
    expect(failure.issues).toHaveLength(2);
  });

  /** The whole point of `detail` staying a parameter: one value, rendered twice, never two. */
  test('the cause is exactly the rendering of that list — the line did not regress', async () => {
    const failure = await refusalOf({ postId: 'not-a-uuid', title: '' });

    expect(failure.cause).toBe(
      `input for action "publishPost" failed validation: ${formatIssues(failure.issues ?? []).join('; ')}`,
    );
  });

  /**
   * The security half. `describeValue` keeps the rejected value out of a MESSAGE; this keeps a
   * foreign library's own members — some of which hold the value — out of the list entirely.
   */
  test('carries only the four members Ultimate mints, never a library’s own', async () => {
    const failure = await refusalOf({ postId: 'not-a-uuid', title: '' });

    for (const issue of failure.issues ?? []) {
      expect(Object.keys(issue).sort()).toEqual(['expected', 'message', 'path', 'received']);
      expect(issue.received).toBe('');
      expect(issue.message).not.toContain('not-a-uuid');
    }
  });

  test('an output refusal keeps the line alone — a server bug is nobody’s form', async () => {
    const failure = await validateOutput(Schema, { postId: 'no', title: '' }, 'publishPost').catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(OutputInvalidError);
    expect((failure as OutputInvalidError).meta?.['issues']).toBeUndefined();
  });
});

describe('validateOutput', () => {
  test('returns the parsed value for a payload the schema accepts', async () => {
    const raw = { postId: '00000000-0000-4000-8000-0000000000aa', title: 'Hello' };

    const parsed = await validateOutput(Schema, raw, 'publishPost');

    expect(parsed).toEqual(raw);
  });

  test('throws OutputInvalidError, carrying the action name and the issue text', async () => {
    const failure = await validateOutput(
      Schema,
      { postId: 'not-a-uuid', title: '' },
      'publishPost',
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(OutputInvalidError);
    expect((failure as OutputInvalidError).code).toBe('X_OUTPUT_INVALID');
    expect((failure as OutputInvalidError).cause).toContain('publishPost');
    expect((failure as OutputInvalidError).cause).toContain('postId');
  });
});
