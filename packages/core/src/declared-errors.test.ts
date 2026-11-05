// `errors:`'s rule, both halves: which throw a list judges and what each environment does with a
// miss, and the first-hop source scan over literals and `defineError` classes.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  ActionErrorsInvalidError,
  checkDeclaredErrors,
  describeDeclaredErrors,
  ErrorUndeclaredError,
  enforceDeclared,
  judgeThrown,
  withDeclaredErrors,
} from './declared-errors';
import {
  bindingAt,
  definedErrorClassCodes,
  frameSite,
  scanHandlerSource,
} from './declared-errors-scan';
import { defineError } from './define-error';
import { UltimateError } from './errors';
import { setLogSink } from './logger';
import { collectMetrics, resetMetrics } from './metrics';

const STATUS: Readonly<Record<string, number>> = {
  X_REFUND_TOO_LATE: 409,
  X_REFUND_TOO_SMALL: 422,
  X_UPSTREAM_DOWN: 503,
  X_ABORTED: 499,
};
const statusOf = (code: string): number | undefined => STATUS[code];
const owner = { primitive: 'action', name: 'refundOrder' } as const;
const coded = (code: string): UltimateError =>
  new UltimateError({ code, cause: 'the fixture threw it', fix: 'nothing: a fixture' });

afterEach(() => {
  resetMetrics();
});

describe('judgeThrown', () => {
  test.each([
    [undefined, 'X_REFUND_TOO_LATE', 409, 'open'],
    [[], 'X_REFUND_TOO_LATE', 409, 'undeclared'],
    [['X_REFUND_TOO_LATE'], 'X_REFUND_TOO_LATE', 409, 'declared'],
    [['X_REFUND_TOO_LATE'], 'X_REFUND_TOO_SMALL', 422, 'undeclared'],
    [[], 'X_UPSTREAM_DOWN', 503, 'exempt'],
    [[], 'X_UNSTATUSED', undefined, 'exempt'],
    [[], 'X_ABORTED', 499, 'exempt'],
    [[], 'X_DRAINING', 400, 'exempt'],
    [[], 'X_REDIRECTED', 399, 'exempt'],
  ] as const)('%p, %s at %p is %s', (declared, code, status, verdict) => {
    expect(judgeThrown(declared, code, status)).toBe(verdict);
  });
});

describe('checkDeclaredErrors', () => {
  test('answers a frozen, sorted copy; absent stays absent', () => {
    const listed = ['X_REFUND_TOO_SMALL', 'X_REFUND_TOO_LATE'];
    const checked = checkDeclaredErrors(listed, statusOf, 'refundOrder');
    expect(checked).toEqual(['X_REFUND_TOO_LATE', 'X_REFUND_TOO_SMALL']);
    expect(Object.isFrozen(checked)).toBe(true);
    expect(checkDeclaredErrors(undefined, statusOf, 'refundOrder')).toBeUndefined();
  });

  test.each([
    [['x_lower'], 'not an X_SCREAMING_SNAKE code'],
    [['X_NEVER_REGISTERED'], 'has no registered HTTP status'],
    [['X_UPSTREAM_DOWN'], 'answers 503, not a 4xx'],
    [['X_REFUND_TOO_LATE', 'X_REFUND_TOO_LATE'], 'is listed twice'],
  ])('%p is X_ACTION_ERRORS_INVALID: %s', (listed, why) => {
    try {
      checkDeclaredErrors(listed, statusOf, 'refundOrder');
    } catch (error) {
      expect(error).toBeInstanceOf(ActionErrorsInvalidError);
      expect((error as UltimateError).code).toBe('X_ACTION_ERRORS_INVALID');
      expect((error as UltimateError).cause).toContain(why);
      return;
    }
    expect.unreachable(`${JSON.stringify(listed)} was accepted`);
  });
});

describe('enforceDeclared', () => {
  const inEnvironment = <T>(value: string | undefined, run: () => T): T => {
    const saved = process.env['ULTIMATE_ENV'];
    const savedNode = process.env['NODE_ENV'];
    if (value === undefined) delete process.env['ULTIMATE_ENV'];
    else process.env['ULTIMATE_ENV'] = value;
    if (value === undefined) delete process.env['NODE_ENV'];
    try {
      return run();
    } finally {
      if (saved === undefined) delete process.env['ULTIMATE_ENV'];
      else process.env['ULTIMATE_ENV'] = saved;
      if (savedNode === undefined) delete process.env['NODE_ENV'];
      else process.env['NODE_ENV'] = savedNode;
    }
  };

  test('a test run raises X_ERROR_UNDECLARED naming the code, the original kept', () => {
    const thrown = coded('X_REFUND_TOO_SMALL');
    const raised = inEnvironment('test', () =>
      enforceDeclared(thrown, ['X_REFUND_TOO_LATE'], statusOf, owner),
    );
    expect(raised).toBeInstanceOf(ErrorUndeclaredError);
    const error = raised as UltimateError;
    expect(error.fix).toContain("'X_REFUND_TOO_SMALL' ]   # add it in the refundOrder definition");
    expect(error.sourceError).toBe(thrown);
  });

  test('production and an unnamed environment pass the original, warn and count', () => {
    const lines: string[] = [];
    const previous = setLogSink((line) => lines.push(line));
    try {
      for (const environment of ['production', undefined]) {
        const thrown = coded('X_REFUND_TOO_SMALL');
        const answered = inEnvironment(environment, () =>
          enforceDeclared(thrown, ['X_REFUND_TOO_LATE'], statusOf, owner),
        );
        expect(answered).toBe(thrown);
      }
    } finally {
      setLogSink(previous);
    }
    // Warned once per (name, code) per process, however many hits; the counter counts each.
    expect(lines.filter((line) => line.includes('declared-errors.undeclared'))).toHaveLength(1);
    const metric = collectMetrics().metrics.find(
      (entry) => entry.descriptor.name === 'undeclared_errors_total',
    );
    expect(metric?.points).toEqual([
      {
        attributes: { primitive: 'action', name: 'refundOrder', code: 'X_REFUND_TOO_SMALL' },
        value: 2,
      },
    ]);
  });

  test('a declared code, a 5xx, a plain throw and an open contract pass untouched', () => {
    const plain = new TypeError('a bug keeps its stack');
    for (const [error, declared] of [
      [coded('X_REFUND_TOO_LATE'), ['X_REFUND_TOO_LATE']],
      [coded('X_UPSTREAM_DOWN'), []],
      [plain, []],
      [coded('X_REFUND_TOO_SMALL'), undefined],
    ] as const) {
      expect(inEnvironment('test', () => enforceDeclared(error, declared, statusOf, owner))).toBe(
        error,
      );
    }
  });

  test('withDeclaredErrors rethrows through the judgement and returns a value untouched', async () => {
    expect(await withDeclaredErrors([], statusOf, owner, () => 7)).toBe(7);
    const failed = withDeclaredErrors([], statusOf, owner, () => {
      throw coded('X_REFUND_TOO_LATE');
    });
    await expect(failed).rejects.toBeInstanceOf(ErrorUndeclaredError);
  });
});

describe('scanHandlerSource', () => {
  const classes = new Map([['Late', 'X_REFUND_TOO_LATE']]);

  test('a literal, a class with and without arguments, a namespaced class', () => {
    expect(scanHandlerSource('() => { throw new Late; }', classes)).toEqual(['X_REFUND_TOO_LATE']);
    expect(scanHandlerSource('() => { throw new E.Late("x"); }', classes)).toEqual([
      'X_REFUND_TOO_LATE',
    ]);
    expect(scanHandlerSource(`() => code === 'X_B' || "X_A" || \`X_C\``, classes)).toEqual([
      'X_A',
      'X_B',
      'X_C',
    ]);
  });

  test('a helper the handler calls is not seen, nor an unknown class, nor a bare word', () => {
    expect(scanHandlerSource('() => refundHelper(X_NOT_QUOTED, new Other)', classes)).toEqual([]);
  });
});

describe('the class map', () => {
  test('frameSite reads both frame shapes', () => {
    expect(frameSite('    at /a/b.ts:8:29')).toEqual({ file: '/a/b.ts', line: 8 });
    expect(frameSite('at module code (file:///a/b c.ts:16:3)')).toEqual({
      file: '/a/b c.ts',
      line: 16,
    });
    expect(frameSite('at native')).toBeNull();
  });

  test('bindingAt reads the declaring line or the one above it', () => {
    const text = 'export const Late = defineError<string>({\nexport const Small =\n  defineError({';
    expect(bindingAt(text, 1)).toBe('Late');
    expect(bindingAt(text, 3)).toBe('Small');
    expect(bindingAt('throw new Late();', 1)).toBeNull();
  });

  test('a defineError class declared here maps its binding to its code', async () => {
    const TooLateForTheScan = defineError({
      code: 'X_DECLARED_SCAN_FIXTURE',
      title: 'declared-errors scan fixture',
      status: 409,
      cause: 'a fixture',
      fix: 'nothing: a fixture',
    });
    expect(TooLateForTheScan.code).toBe('X_DECLARED_SCAN_FIXTURE');
    const codes = await definedErrorClassCodes();
    expect(codes.get('TooLateForTheScan')).toBe('X_DECLARED_SCAN_FIXTURE');
    const unread = await definedErrorClassCodes(() => Promise.reject(new TypeError('no disk')));
    expect(unread.get('TooLateForTheScan')).toBeUndefined();
  });
});

describe('describeDeclaredErrors', () => {
  test('ends the description with the list; absent or empty leaves it alone', () => {
    expect(describeDeclaredErrors('Refund an order.', ['X_A', 'X_B'])).toBe(
      'Refund an order. Declared refusals: X_A, X_B.',
    );
    expect(describeDeclaredErrors('Refund an order.', [])).toBe('Refund an order.');
    expect(describeDeclaredErrors('Refund an order.', undefined)).toBe('Refund an order.');
  });
});
