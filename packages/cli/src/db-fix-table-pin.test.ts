// Holds `@ultimat3/db`'s SQLSTATE fix table to the rule the `errors` step applies to literals.
// That step reads `fix:` string literals, and a table indexed at run time puts no literal in the
// `fix:` position — so these six were checked by hand and nothing would catch a seventh (#97).
// Here rather than in `db`, because `fixProblem` is `@ultimat3/cli`'s and imports go DOWN.

import { describe, expect, test } from 'bun:test';
import { DB_SQLSTATE_CODES, driverError, SQLSTATE } from '@ultimat3/db';
import { fixProblem } from './error-contract';

/** What the driver hands up: a real thrown object carrying the server's SQLSTATE. */
const pgError = (code: string, constraint?: string): unknown =>
  Object.assign(new Error('driver said no'), {
    code,
    ...(constraint === undefined ? {} : { constraint }),
  });

const states = Object.keys(DB_SQLSTATE_CODES);

/**
 * Asked at the rendered end, not the table: building the REAL error also covers the `{constraint}`
 * substitution, which is where a server-supplied identifier enters the line an operator pastes.
 */
describe('every SQLSTATE fix passes the rule the errors step applies to literals', () => {
  test('the table covers every state the driver classifies', () => {
    expect(states.length).toBeGreaterThan(0);
    // A state in the map with no fix behind it would render `undefined` into the fix line.
    for (const state of states) {
      const error = driverError('insert into posts', pgError(state));
      expect(typeof error.fix).toBe('string');
      expect(error.fix.length).toBeGreaterThan(0);
      expect(error.fix).not.toInclude('undefined');
    }
  });

  test('no rendered fix is a banned phrase or cites a command this build lacks', () => {
    const problems = states
      .map((state) => ({ state, problem: fixProblem(driverError('op', pgError(state)).fix) }))
      .filter((entry) => entry.problem !== undefined);
    expect(problems).toEqual([]);
  });

  test('a server-named constraint is substituted, and the result still passes', () => {
    const error = driverError(
      'insert into posts',
      pgError(SQLSTATE.uniqueViolation, 'posts_slug_key'),
    );
    expect(error.fix).toInclude('posts_slug_key');
    expect(error.fix).not.toInclude('{constraint}');
    expect(fixProblem(error.fix)).toBeUndefined();
  });

  test('an unnamed constraint leaves no placeholder behind, and still passes', () => {
    const error = driverError('insert into posts', pgError(SQLSTATE.uniqueViolation));
    expect(error.fix).not.toInclude('{constraint}');
    expect(fixProblem(error.fix)).toBeUndefined();
  });

  // `String.replace` expands `$&` and friends inside a replacement LITERAL. `driverError` passes a
  // function for that reason; this is the test that would fail if someone simplified it back.
  test('a constraint carrying $& cannot splice the placeholder back into the fix', () => {
    const error = driverError(
      'insert into posts',
      pgError(SQLSTATE.uniqueViolation, 'posts_$&_key'),
    );
    expect(error.fix).toInclude('posts_$&_key');
    expect(error.fix).not.toInclude('{constraint}');
  });
});
