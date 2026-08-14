/**
 * `validateInput`/`validateOutput` are the one parse path every surface shares —
 * covered directly here so the two failure modes (bad input, drifted output)
 * stay pinned to their own code and carry the action name and the issue text.
 */

import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import { InputInvalidError, OutputInvalidError } from './errors';
import { validateInput, validateOutput } from './validate';

const Schema = t.object({ postId: t.uuid, title: t.string.min(1) });

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
