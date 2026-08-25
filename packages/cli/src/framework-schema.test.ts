// The list against itself: a row may not claim a table its own SQL never creates, and the SQL may
// not create one no row claims. Both directions, because only the second one catches the defect
// this file exists for — a package adds a table to a constant the boot already applies, and the
// list still reads as complete.

import { describe, expect, test } from 'bun:test';
import { AUTH_TABLE_NAMES } from '@ultimat3/auth';
import {
  applyFrameworkSchema,
  FRAMEWORK_SCHEMA,
  frameworkTableNames,
  schemaStatements,
} from './framework-schema';

/** `create table if not exists x_jobs (` -> `x_jobs`. The only shape any framework DDL uses. */
const created = (ddl: readonly string[]): readonly string[] =>
  [...ddl.join(';').matchAll(/create table (?:if not exists )?([a-z_0-9]+)/g)].map(
    (match) => match[1] as string,
  );

describe('unit · framework schema', () => {
  test('every row creates exactly the tables it claims, and claims exactly what it creates', () => {
    for (const entry of FRAMEWORK_SCHEMA) {
      expect([...created(entry.ddl)].sort(), `${entry.pkg} row`).toEqual([...entry.tables].sort());
    }
  });

  test('the five tables BuiltinAdapter reads are applied at boot', () => {
    // The oldest hole in the list, and the one with a written consequence: `examples/dummy`'s own
    // CLAUDE.md records that nobody can hold a session in the reference app because nothing ever
    // created these. `AUTH_TABLE_NAMES` is @ultimat3/auth's list, never a copy of it.
    const names = frameworkTableNames();
    for (const table of AUTH_TABLE_NAMES) expect(names).toContain(table);
    expect(AUTH_TABLE_NAMES.length).toBe(5);
  });

  test('both notify tables are applied at boot', () => {
    // A missing delivery ledger is `42P01` on the first claim inside a worker, which reads as a
    // dead-lettered notification rather than as a missing schema.
    expect(frameworkTableNames()).toContain('x_notify_deliveries');
    expect(frameworkTableNames()).toContain('x_notify_inbox');
  });

  test('no table is created by two rows, so no row can be deleted as a duplicate', () => {
    const names = frameworkTableNames();
    expect([...new Set(names)].length).toBe(names.length);
  });

  test('every statement handed to the executor is non-empty and applied in row order', async () => {
    const seen: string[] = [];
    const applied = await applyFrameworkSchema((statement) => {
      seen.push(statement.trim());
      return Promise.resolve();
    });

    expect(seen.every((statement) => statement.length > 0)).toBe(true);
    expect(applied).toEqual(frameworkTableNames());
    // `x_users` before `x_sessions`: the second carries a foreign key onto the first, so row order
    // is a correctness property and not a style one.
    const users = seen.findIndex((statement) =>
      statement.includes('create table if not exists x_users'),
    );
    const sessions = seen.findIndex((statement) =>
      statement.includes('create table if not exists x_sessions'),
    );
    expect(users).toBeGreaterThanOrEqual(0);
    expect(sessions).toBeGreaterThan(users);
  });

  test('a failing statement names the package and the tables, never the driver rejection alone', async () => {
    // A foreign error handed to the code under test is legitimate INPUT, not a test verdict.
    const boom = new Error('permission denied for schema public');
    await expect(applyFrameworkSchema(() => Promise.reject(boom))).rejects.toBeUltimateError(
      'X_FRAMEWORK_SCHEMA_FAILED',
    );

    const raised = await applyFrameworkSchema(() => Promise.reject(boom)).catch(
      (error: unknown) => error,
    );
    expect(raised).toBeInstanceOf(Error);
    const rendered = raised as { cause: string; fix: string };
    expect(rendered.cause).toContain('@ultimat3/jobs');
    expect(rendered.cause).toContain('x_jobs');
    expect(rendered.cause).toContain('permission denied for schema public');
    expect(rendered.fix).toContain('x db migrate');
  });

  test('a rejection whose toString throws still renders, because a caught value is annotated by nobody', async () => {
    const hostile = {
      toString() {
        throw new TypeError('no');
      },
    };
    await expect(applyFrameworkSchema(() => Promise.reject(hostile))).rejects.toBeUltimateError(
      'X_FRAMEWORK_SCHEMA_FAILED',
    );
  });

  test('splitting drops the empty tail a trailing semicolon leaves', () => {
    expect(schemaStatements(['create table a ();', '', '  '])).toEqual(['create table a ()']);
  });
});
