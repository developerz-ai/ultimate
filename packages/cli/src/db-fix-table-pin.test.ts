// `@ultimat3/db` builds every driver `fix:` from the `SQLSTATE_FIXES` LOOKUP TABLE, and the
// `errors` step cannot see one.
//
// `checkErrorFixes` reads `fix:` string literals out of source (`fix-scan.ts`). A table indexed at
// run time — `fix: SQLSTATE_FIXES[code].replace(...)` — puts no literal in the `fix:` position, so
// the six strings behind the framework's most operationally loaded errors were checked by hand and
// nothing would have caught a seventh (#97, "Related, same family").
//
// This closes it by asking the question at the other end: build the REAL error for every SQLSTATE
// the driver classifies and hold its rendered `fix` to `fixProblem` — the same rule the gate
// applies to every literal in the repo. Checking the rendered string is strictly better than
// checking the table, because it also covers the `{constraint}` substitution, which is where a
// server-supplied identifier enters the line an operator is told to paste.
//
// It lives here rather than in `@ultimat3/db` because `fixProblem` is `@ultimat3/cli`'s and `db` is
// tier 1 — imports go DOWN, so `db` can never reach it. Same arrangement as the tier-0 pins.

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
