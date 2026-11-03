// The `psql` URL a pooler fix pastes, run through a real shell: only the `options` query parameter
// goes, and a password that happens to read `&options=` keeps the credentials, host and database.

import { describe, expect, test } from 'bun:test';
import { poolerOptionsRefusedFix } from './pooler-fix';

/** The `$(…)` the fix hands psql, evaluated by `sh` with `DATABASE_URL` set. */
function urlPsqlGets(databaseUrl: string): string {
  const fix = poolerOptionsRefusedFix('lock_timeout');
  const start = fix.indexOf('psql "') + 'psql "'.length;
  const substitution = fix.slice(start, fix.indexOf(')" -c', start) + 1);
  const run = Bun.spawnSync(['sh', '-c', `printf '%s' "${substitution}"`], {
    env: { PATH: process.env['PATH'] ?? '', DATABASE_URL: databaseUrl },
    timeout: 5_000,
  });
  return run.stdout.toString();
}

describe('poolerOptionsRefusedFix · the URL psql connects with', () => {
  test.each([
    [
      'options between two parameters',
      'postgres://u:p@h:6432/app?sslmode=require&options=-c%20lock_timeout%3D5s&application_name=web',
      'postgres://u:p@h:6432/app?sslmode=require&application_name=web',
    ],
    ['options alone', 'postgres://u:p@h/app?options=-c%20x%3D1', 'postgres://u:p@h/app'],
    [
      'options last',
      'postgres://u:p@h/app?sslmode=require&options=x',
      'postgres://u:p@h/app?sslmode=require',
    ],
    ['no options', 'postgres://u:p@h/app?sslmode=require', 'postgres://u:p@h/app?sslmode=require'],
    [
      'a password reading &options=',
      'postgres://u:p&options=z@h/app?sslmode=require',
      'postgres://u:p&options=z@h/app?sslmode=require',
    ],
    [
      'a password reading &options= and a real options',
      'postgres://u:p&options=z@h/app?options=-c%20x%3D1&sslmode=require',
      'postgres://u:p&options=z@h/app?sslmode=require',
    ],
  ])('%s', (_label, given, expected) => {
    expect(urlPsqlGets(given)).toBe(expected);
  });
});
