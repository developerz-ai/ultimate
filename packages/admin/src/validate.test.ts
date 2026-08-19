// Form input → the ENTITY's own Standard Schema. The admin writes no second set of rules, so the
// only decisions this file makes are: is this thing a schema at all, what does an issue's path
// look like once flattened, and which object is handed back on success.

import { describe, expect, test } from 'bun:test';
import { validateInput } from './validate';

type Result = { readonly value?: unknown; readonly issues?: readonly unknown[] };

/** A Standard Schema whose validate is whatever the test hands it. */
const schemaOf = (validate: (value: unknown) => Result | Promise<Result>): unknown => ({
  '~standard': { validate },
});

describe('a value that is not a Standard Schema', () => {
  const NOT_SCHEMAS: readonly (readonly [string, unknown])[] = [
    ['undefined', undefined],
    ['null', null],
    ['a string', 'nope'],
    ['an object with no ~standard', { validate: (): Result => ({ value: {} }) }],
    ['a ~standard whose validate is not a function', { '~standard': { validate: 'nope' } }],
  ];

  for (const [name, schema] of NOT_SCHEMAS) {
    test(`${name} accepts the input as-is`, async () => {
      // `x verify` fails on an entity with no schema, so this branch means a hand-written test
      // fixture — never a production hole. It must not throw and must not drop fields.
      const input = { title: 'Hello', draft: true };
      expect(await validateInput(schema, input)).toEqual({ ok: true, value: input });
    });
  }
});

describe('a schema that rejects', () => {
  test('every issue comes back with a dotted path and its own message', async () => {
    const result = await validateInput(
      schemaOf(() => ({
        issues: [
          { message: 'expected a string', path: ['title'] },
          { message: 'expected a number', path: ['meta', 'count'] },
        ],
      })),
      {},
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([
      { path: 'title', message: 'expected a string' },
      { path: 'meta.count', message: 'expected a number' },
    ]);
  });

  test('a path segment given as { key } is read through, and an index becomes a number segment', async () => {
    const result = await validateInput(
      schemaOf(() => ({ issues: [{ message: 'bad', path: [{ key: 'tags' }, 0, { key: 'id' }] }] })),
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues[0]?.path).toBe('tags.0.id');
  });

  test('an issue with no path at all is the root, spelled as the empty string', async () => {
    const result = await validateInput(
      schemaOf(() => ({ issues: [{ message: 'bad row' }] })),
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues).toEqual([{ path: '', message: 'bad row' }]);
  });

  test('an EMPTY issue list is a pass, not a failure with nothing to show', async () => {
    const result = await validateInput(
      schemaOf(() => ({ issues: [], value: { a: 1 } })),
      { a: 2 },
    );
    expect(result).toEqual({ ok: true, value: { a: 1 } });
  });
});

describe('a schema that accepts', () => {
  test('the SCHEMA’s value is what comes back — a coerced field must reach the repo', async () => {
    const result = await validateInput(
      schemaOf((value) => ({ value: { ...(value as object), count: 3 } })),
      { count: '3' },
    );
    expect(result).toEqual({ ok: true, value: { count: 3 } });
  });

  test('an async validate is awaited', async () => {
    const result = await validateInput(
      schemaOf(async () => ({ value: { title: 'from the schema' } })),
      { title: 'from the caller' },
    );
    expect(result).toEqual({ ok: true, value: { title: 'from the schema' } });
  });

  test('a validate that returns a non-object value falls back to the caller’s input', async () => {
    // A provider that answers `undefined`, or a primitive, must not blank the row being written.
    expect(
      await validateInput(
        schemaOf(() => ({})),
        { a: 1 },
      ),
    ).toEqual({ ok: true, value: { a: 1 } });
    expect(
      await validateInput(
        schemaOf(() => ({ value: null })),
        { a: 1 },
      ),
    ).toEqual({
      ok: true,
      value: { a: 1 },
    });
    expect(
      await validateInput(
        schemaOf(() => ({ value: 'nope' })),
        { a: 1 },
      ),
    ).toEqual({
      ok: true,
      value: { a: 1 },
    });
  });
});
