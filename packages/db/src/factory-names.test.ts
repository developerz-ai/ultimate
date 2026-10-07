// Pins the factory naming 25.0.0 collapsed to: a backend factory is `postgresX` / `memoryX`, one
// name per factory. `createPostgresClient` was the db spelling of the `create*` / `pg*` family the
// other packages used beside `memory*` / `postgres*`, so the same question had two answers.

import { describe, expect, test } from 'bun:test';
import * as db from './index';

/** The retired prefixes. PGlite's factory is not a Postgres-server backend; it keeps its name. */
const RETIRED = /^(?:create(?:Memory|Postgres|Pg(?!lite))|pg[A-Z])/;

describe('@ultimat3/db factory names', () => {
  test('the Postgres client factory is postgresClient, and only that', () => {
    expect(typeof db.postgresClient).toBe('function');
    expect(Object.hasOwn(db, 'createPostgresClient')).toBe(false);
  });

  test('no export carries a retired create*/pg* spelling', () => {
    expect(Object.keys(db).filter((name) => RETIRED.test(name))).toEqual([]);
  });
});
