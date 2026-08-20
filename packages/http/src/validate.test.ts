// Validation reaches the app through Standard Schema rather than a vendor API, so this seam
// has to behave the same for a hand-written validator as for the shipped `t`, and has to say
// something an agent can act on when an async schema is used on the sync path. Neither is
// visible in the type, so both are asserted here.
import { describe, expect, test } from 'bun:test';
import type { StandardResult } from '@ultimat3/schema';
import { t } from '@ultimat3/schema';
import type { Schema } from './validate';
import { formatIssue, validate, validateSync } from './validate';

// `StandardResult` comes from `@ultimat3/schema`, never a copy declared here: this file exists to
// prove the seam behaves for a HAND-WRITTEN validator, and a hand-written validator conforms to
// the shipped interface or it is not the thing under test. The local copy had drifted — a success
// arm with no `issues?: undefined` discriminant and a path of `unknown[]` — so it described a
// vendor `Schema<Out>` would not have accepted.

const syncSchema = <Out>(validateFn: (value: unknown) => StandardResult<Out>): Schema<Out> => ({
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: validateFn,
  },
});

const asyncSchema = <Out>(validateFn: (value: unknown) => StandardResult<Out>): Schema<Out> => ({
  '~standard': {
    version: 1,
    vendor: 'ultimate-test',
    validate: (value: unknown) => Promise.resolve(validateFn(value)),
  },
});

describe('formatIssue', () => {
  test('joins a path of strings and numbers with dots', () => {
    expect(formatIssue({ message: 'must be a string', path: ['posts', 0, 'title'] })).toBe(
      'posts.0.title: must be a string',
    );
  });

  test('extracts a path segment object`s key property', () => {
    expect(
      formatIssue({ message: 'required', path: ['posts', { key: 0 }, { key: 'title' }] }),
    ).toBe('posts.0.title: required');
  });

  test('an empty path returns just the message', () => {
    expect(formatIssue({ message: 'bad body', path: [] })).toBe('bad body');
  });

  test('an absent path returns just the message', () => {
    expect(formatIssue({ message: 'bad body' })).toBe('bad body');
  });
});

describe('validateSync', () => {
  test('returns ok with the parsed value on success', () => {
    const schema = syncSchema<{ title: string }>((value) => ({
      value: value as { title: string },
    }));
    const result = validateSync(schema, { title: 'hi' });
    expect(result).toEqual({ ok: true, value: { title: 'hi' } });
  });

  test('returns formatted issues on failure', () => {
    const schema = syncSchema<string>(() => ({
      issues: [{ message: 'must be a string', path: ['title'] }],
    }));
    const result = validateSync(schema, 42);
    expect(result).toEqual({ ok: false, issues: ['title: must be a string'] });
  });

  test('an async schema misused synchronously fails with a fixed message', () => {
    const schema = asyncSchema<string>((value) => ({ value: value as string }));
    const result = validateSync(schema, 'x');
    expect(result).toEqual({
      ok: false,
      issues: ['schema is async; use validate() for request bodies'],
    });
  });

  test('validates a real `t`-backed schema synchronously', () => {
    const schema = t.object({ name: t.string });
    const ok = validateSync(schema, { name: 'ada' });
    expect(ok).toEqual({ ok: true, value: { name: 'ada' } });

    const bad = validateSync(schema, { name: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.length).toBeGreaterThan(0);
    }
  });
});

// A Standard Schema result is discriminated by the PRESENCE of `issues`: `StandardSuccessResult`
// declares `issues?: undefined` and `StandardFailureResult` carries no `value` at all
// (`@ultimat3/schema`'s `standard.ts`). Reading the LENGTH instead turned a failure result with an
// empty array into `{ ok: true, value: undefined }` — so `request.query()` handed a handler
// `undefined` where its type promised a parsed object, the `body` stage put that `undefined` in
// `ctx.input`, and the first property read off it was a TypeError answered as X_INTERNAL 500.
describe('a failure result carrying no issues is still a failure', () => {
  const empty = <Out>() => syncSchema<Out>(() => ({ issues: [] }));

  test('validateSync refuses it instead of passing undefined off as the value', () => {
    const result = validateSync(empty<{ title: string }>(), { title: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues).toEqual(['the schema reported a failure with no issues']);
  });

  test('validate refuses it too, on the async path', async () => {
    const schema = asyncSchema<{ title: string }>(() => ({ issues: [] }));
    const result = await validate(schema, { title: 'hi' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.issues.length).toBeGreaterThan(0);
  });

  test('a success result is still success, empty issues array or not', () => {
    const result = validateSync(
      syncSchema<number>((value) => ({ value: value as number })),
      7,
    );
    expect(result).toEqual({ ok: true, value: 7 });
  });
});

describe('validate', () => {
  test('awaits an async schema and returns ok with the value', async () => {
    const schema = asyncSchema<{ title: string }>((value) => ({
      value: value as { title: string },
    }));
    const result = await validate(schema, { title: 'hi' });
    expect(result).toEqual({ ok: true, value: { title: 'hi' } });
  });

  test('awaits an async schema and returns formatted issues on failure', async () => {
    const schema = asyncSchema<string>(() => ({
      issues: [{ message: 'must not be empty', path: [] }],
    }));
    const result = await validate(schema, '');
    expect(result).toEqual({ ok: false, issues: ['must not be empty'] });
  });

  test('also accepts a synchronous schema (validate always returns a promise)', async () => {
    const schema = syncSchema<number>((value) => ({ value: value as number }));
    const result = await validate(schema, 7);
    expect(result).toEqual({ ok: true, value: 7 });
  });

  test('validates a real `t`-backed schema across valid and invalid values', async () => {
    const schema = t.object({ name: t.string });

    const ok = await validate(schema, { name: 'grace' });
    expect(ok).toEqual({ ok: true, value: { name: 'grace' } });

    const bad = await validate(schema, { name: 42 });
    expect(bad.ok).toBe(false);
    if (!bad.ok) {
      expect(bad.issues.length).toBeGreaterThan(0);
    }
  });
});
