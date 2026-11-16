// `calledFunctions` reads every call in agent-written SQL (sweep 8b-3, CodeQL js/polynomial-redos):
// the call pattern retried an identifier run from each of its characters, so 100k letters and no
// `(` cost 15.9 s on Bun. A match may only start where a run starts now; the old pattern is the
// oracle the new one must agree with.

import { describe, expect, test } from 'bun:test';
import { calledFunctions } from './readonly-sql-calls';

const OLD_CALL = /([a-z_][a-z0-9_$]*)\s*\(/g;
const oldCalled = (sql: string): readonly string[] =>
  [...sql.toLowerCase().matchAll(OLD_CALL)].map((match) => match[1] ?? '');

describe('calledFunctions reads calls in linear time, with the old answers', () => {
  test('every string of up to 5 identifier, space and paren characters', () => {
    const alphabet = ['a', 'B', '_', '1', '$', '(', ' ', ' ', '.'];
    let level = [''];
    for (let length = 0; length <= 5; length += 1) {
      for (const sql of level) expect([sql, calledFunctions(sql)]).toEqual([sql, oldCalled(sql)]);
      level = level.flatMap((head) => alphabet.map((one) => head + one));
    }
  });

  test('the names a real statement calls, schema-qualified and digit-led runs included', () => {
    const sql = 'select pg_catalog.set_config ( 1, 2), 9lower(x), $1abs(y) from t where now()';
    expect(calledFunctions(sql)).toEqual(['set_config', 'lower', 'abs', 'now']);
  });

  test('100k identifier characters with no call are read in well under a second', () => {
    const started = performance.now();
    expect(calledFunctions('a'.repeat(100_000))).toEqual([]);
    expect(calledFunctions(`a${' '.repeat(100_000)}b(`)).toEqual(['b']);
    expect(performance.now() - started).toBeLessThan(250);
  });
});
