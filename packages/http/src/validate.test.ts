import { describe, expect, test } from 'bun:test';
import { t } from '@ultimat3/schema';
import type { Schema } from './validate';
import { formatIssue, validate, validateSync } from './validate';

type StandardResult<Out> =
  | { readonly value: Out }
  | {
      readonly issues: readonly { readonly message: string; readonly path?: readonly unknown[] }[];
    };

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

  test('validates a real ArkType-backed schema synchronously', () => {
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

  test('validates a real ArkType-backed schema across valid and invalid values', async () => {
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
