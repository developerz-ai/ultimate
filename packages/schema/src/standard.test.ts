import { describe, expect, test } from 'bun:test';
import { SchemaUnsupportedError, ValidationFailedError } from './errors';
import {
  formatIssues,
  formatPath,
  isStandardSchema,
  parse,
  parseAsync,
  type StandardResult,
  type StandardSchemaV1,
  toValidationIssues,
  validate,
  validateAsync,
} from './standard';

describe('formatPath', () => {
  test('undefined path is empty', () => {
    expect(formatPath(undefined)).toBe('');
  });

  test('empty path is empty', () => {
    expect(formatPath([])).toBe('');
  });

  test('string keys join with a dot', () => {
    expect(formatPath(['a', 'b', 'c'])).toBe('a.b.c');
  });

  test('numeric keys render as [n] with no leading dot', () => {
    expect(formatPath([0])).toBe('[0]');
    expect(formatPath(['items', 0])).toBe('items[0]');
  });

  test('a StandardPathSegment object and a bare PropertyKey both work', () => {
    expect(formatPath([{ key: 'a' }, { key: 0 }])).toBe('a[0]');
    expect(formatPath(['a', { key: 0 }])).toBe('a[0]');
  });

  test('the doc example: items[0].price', () => {
    expect(formatPath(['items', 0, 'price'])).toBe('items[0].price');
  });
});

describe('formatIssues', () => {
  test('an issue with an empty formatted path renders just the message', () => {
    expect(formatIssues([{ message: 'bad value', path: [] }])).toEqual(['bad value']);
    expect(formatIssues([{ message: 'bad value' }])).toEqual(['bad value']);
  });

  test('a nonempty path renders as `path: message`', () => {
    expect(formatIssues([{ message: 'required', path: ['name'] }])).toEqual(['name: required']);
  });

  test('a FormattableIssue whose path is already a plain string is used as-is', () => {
    expect(formatIssues([{ message: 'required', path: 'items[0].price' }])).toEqual([
      'items[0].price: required',
    ]);
  });
});

describe('toValidationIssues', () => {
  test('maps each StandardIssue to a ValidationIssue', () => {
    const issues = toValidationIssues([{ message: 'must be a string', path: ['name'] }]);
    expect(issues).toEqual([
      {
        path: 'name',
        expected: 'must be a string',
        received: '',
        message: 'must be a string',
      },
    ]);
  });

  test('formats an empty path', () => {
    const issues = toValidationIssues([{ message: 'root is invalid' }]);
    expect(issues[0]?.path).toBe('');
  });
});

function makeSyncSchema(
  outcome: (value: unknown) => StandardResult<unknown>,
): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: outcome,
    },
  };
}

function makeAsyncSchema(
  outcome: (value: unknown) => StandardResult<unknown>,
): StandardSchemaV1<unknown, unknown> {
  return {
    '~standard': {
      version: 1,
      vendor: 'test',
      validate: (value: unknown) => Promise.resolve(outcome(value)),
    },
  };
}

describe('validate', () => {
  test('returns a success result unchanged', () => {
    const schema = makeSyncSchema((value) => ({ value }));
    expect(validate(schema, 'ok')).toEqual({ value: 'ok' });
  });

  test('returns a failure result unchanged', () => {
    const schema = makeSyncSchema(() => ({ issues: [{ message: 'nope' }] }));
    expect(validate(schema, 'bad')).toEqual({ issues: [{ message: 'nope' }] });
  });

  test('throws SchemaUnsupportedError when the schema validates asynchronously', () => {
    const schema = makeAsyncSchema((value) => ({ value }));
    expect(() => validate(schema, 'ok')).toThrow(SchemaUnsupportedError);

    let caught: unknown;
    try {
      validate(schema, 'ok');
    } catch (error) {
      caught = error;
    }
    // Asserted outside the catch: a call that stopped throwing would otherwise skip the block and
    // pass, which is the one outcome these cases exist to catch.
    expect(caught).toBeInstanceOf(SchemaUnsupportedError);
    expect((caught as SchemaUnsupportedError).code).toBe('X_SCHEMA_UNSUPPORTED');
  });
});

describe('validateAsync', () => {
  test('awaits a Promise-returning validator', async () => {
    const schema = makeAsyncSchema((value) => ({ value }));
    await expect(validateAsync(schema, 'ok')).resolves.toEqual({ value: 'ok' });
  });

  test('also accepts a sync-returning validator', async () => {
    const schema = makeSyncSchema((value) => ({ value }));
    await expect(validateAsync(schema, 'ok')).resolves.toEqual({ value: 'ok' });
  });
});

describe('parse', () => {
  test('returns .value on success', () => {
    const schema = makeSyncSchema((value) => ({ value }));
    expect(parse(schema, 'ok')).toBe('ok');
  });

  test('throws ValidationFailedError on issues', () => {
    const schema = makeSyncSchema(() => ({ issues: [{ message: 'required', path: ['name'] }] }));
    expect(() => parse(schema, {})).toThrow(ValidationFailedError);

    let caught: unknown;
    try {
      parse(schema, {});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationFailedError);
    expect((caught as ValidationFailedError).code).toBe('X_VALIDATION_FAILED');
  });

  test('threads the root param through the thrown error', () => {
    const schema = makeSyncSchema(() => ({ issues: [{ message: 'required' }] }));
    let caught: unknown;
    try {
      parse(schema, {}, 'input');
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(ValidationFailedError);
    expect((caught as ValidationFailedError).cause).toContain('input: required');
  });
});

describe('parseAsync', () => {
  test('returns .value on success', async () => {
    const schema = makeAsyncSchema((value) => ({ value }));
    await expect(parseAsync(schema, 'ok')).resolves.toBe('ok');
  });

  test('throws ValidationFailedError on issues', async () => {
    const schema = makeAsyncSchema(() => ({ issues: [{ message: 'required' }] }));
    await expect(parseAsync(schema, {})).rejects.toBeInstanceOf(ValidationFailedError);
  });
});

describe('isStandardSchema', () => {
  test('true for a well-formed object', () => {
    const schema = makeSyncSchema((value) => ({ value }));
    expect(isStandardSchema(schema)).toBe(true);
  });

  test('false for null', () => {
    expect(isStandardSchema(null)).toBe(false);
  });

  test('false for non-objects', () => {
    expect(isStandardSchema('a string')).toBe(false);
    expect(isStandardSchema(42)).toBe(false);
    expect(isStandardSchema(undefined)).toBe(false);
  });

  test('false when ~standard is missing', () => {
    expect(isStandardSchema({})).toBe(false);
  });

  test('false when ~standard is present but version !== 1', () => {
    expect(
      isStandardSchema({
        '~standard': { version: 2, vendor: 'x', validate: () => ({ value: 1 }) },
      }),
    ).toBe(false);
  });

  test('false when ~standard.validate is not a function', () => {
    expect(isStandardSchema({ '~standard': { version: 1, vendor: 'x', validate: 'nope' } })).toBe(
      false,
    );
  });
});
