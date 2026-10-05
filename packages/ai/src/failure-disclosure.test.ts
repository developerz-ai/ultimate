// The one rule for what of a thrown value a remote reader sees — and what the LOG keeps of the
// half it withholds. The logger redacts by field name, never by content, so the withheld half is
// logged as facts that cannot carry PII: the code, the error's name, and the frames.

import { describe, expect, test } from 'bun:test';
import { createLogger, UltimateError } from '@ultimat3/core';
import { discloseFailure } from './failure-disclosure';

/** A logger whose lines land in `lines`, at the level the withheld half is logged on. */
const capture = () => {
  const lines: string[] = [];
  return { lines, logger: createLogger({ level: 'error', writer: (line) => lines.push(line) }) };
};

describe('a withheld failure is logged without its content', () => {
  test('a foreign error with an email in its message: the address is in no log line', () => {
    const { lines, logger } = capture();
    const thrown = new Error('Key (email)=(ceo@corp.com) already exists');
    const shown = discloseFailure(thrown, logger, 'tool insertUser');
    expect(shown.cause).toBeUndefined();
    const log = lines.join('\n');
    expect(log).not.toContain('ceo@corp.com');
    expect(log).toContain('uncoded');
    expect(log).toContain('"name":"Error"');
    expect(log).toContain('failure-disclosure.test.ts');
  });

  test('a withheld 5xx cause stays out of the log; its code is in it', () => {
    const { lines, logger } = capture();
    const thrown = new UltimateError({
      code: 'X_INVARIANT',
      cause: 'tenant org-42 row for ceo@corp.com has no owner',
      fix: 'psql -c "select * from x_users where email = $EMAIL"   # EMAIL=ceo@corp.com',
    });
    discloseFailure(thrown, logger, 'hive member 0');
    const log = lines.join('\n');
    expect(log).not.toContain('ceo@corp.com');
    expect(log).not.toContain('org-42');
    expect(log).toContain('X_INVARIANT');
  });

  test('a message spanning several lines leaves none of them in the frames', () => {
    const { lines, logger } = capture();
    discloseFailure(new Error('first line\nsecond: ceo@corp.com\n    at not-a-frame'), logger, 'x');
    expect(lines.join('\n')).not.toContain('ceo@corp.com');
  });

  test('a shown failure logs nothing', () => {
    const { lines, logger } = capture();
    const shown = discloseFailure(
      new UltimateError({ code: 'X_INPUT_INVALID', cause: 'title is required', fix: 'send one' }),
      logger,
      'x',
    );
    expect(shown.cause).toBe('title is required');
    expect(lines).toEqual([]);
  });
});
