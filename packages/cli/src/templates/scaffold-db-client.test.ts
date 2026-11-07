// The handle `x new` writes: the entity set `x g entity` adds to, in the one shape the registrar
// edits. An inline `database({ … })` would re-wrap as it grew; a named, expanded set never does.

import { describe, expect, test } from 'bun:test';
import { names } from './naming';
import {
  dbClientFiles,
  dbClientSource,
  HANDLE_FILE,
  handleEntryFor,
  webModuleOf,
} from './scaffold-db-client';

const clientOf = (app: string, example: boolean): string =>
  String(dbClientFiles(names(app), example).find((file) => file.path === HANDLE_FILE)?.contents);

describe('unit · the packages/db client x new writes', () => {
  test('with the example slice the set holds post, keyed by its table', () => {
    const client = clientOf('ledger-demo', true);
    expect(client).toContain("import { post } from '@ledger-demo/web/app/post/entity';");
    expect(client).toContain('const entities = {\n  posts: post,\n};');
    expect(client).toContain('export const db = database(entities, { driver });');
  });

  test('with --no-example the set is empty, and nothing imports the web workspace', () => {
    const client = clientOf('ledger-demo', false);
    expect(client).toContain('const entities = {};');
    expect(client).not.toContain('@ledger-demo/web');
  });

  // One answer to "which store backs this seam", decided by core: a scaffold that writes its own
  // environment ternary is a fourth predicate the next app copies, and the three that shipped had
  // already disagreed (two read the environment, one read DATABASE_URL).
  test("the driver is chosen by core's storeMode, never a local environment ternary", () => {
    const client = clientOf('ledger-demo', true);
    expect(client).toContain("import { storeMode } from '@ultimat3/core';");
    expect(client).toContain("storeMode(env) === 'memory' ? testDriver() : postgresDriver()");
    expect(client).not.toContain('resolveEnvironment');
    expect(client).not.toMatch(/=== 'test'/);
  });

  // Under test the handle follows `setDbClient`: a test that installs its migrated database reads
  // and writes it through `db`, and one that installs none is exactly the memory driver.
  test('under test the handle takes testDriver, so it follows an installed client', () => {
    const client = clientOf('ledger-demo', true);
    expect(client).toContain(
      "import { type Driver, database, postgresDriver, testDriver } from '@ultimat3/entity';",
    );
    expect(client).not.toContain('memoryDriver');
    const test = String(
      dbClientFiles(names('ledger-demo'), true).find(
        (file) => file.path === 'packages/db/src/client.test.ts',
      )?.contents,
    );
    expect(test).toContain('setDbClient(client);');
    expect(test).toContain("expect(client.texts).toContain('BEGIN');");
  });

  // `typeof db === 'object'` held for a handle over ANY driver. The generated test reads every
  // table under an installed client, so a handle built without `{ driver }` fails it.
  test('the generated test reads every table through the exported driver', () => {
    const test = String(
      dbClientFiles(names('ledger-demo'), true).find(
        (file) => file.path === 'packages/db/src/client.test.ts',
      )?.contents,
    );
    expect(test).not.toContain('typeof db');
    expect(test).toContain('Object.values(db)');
    expect(test).toContain('await table.all();');
    expect(test).toContain('expect(client.statements.length).toBeGreaterThan(before);');
  });

  test('the client ships with the test that covers it', () => {
    const paths = dbClientFiles(names('ledger-demo'), true).map((file) => file.path);
    expect(paths).toEqual([HANDLE_FILE, 'packages/db/src/client.test.ts']);
  });

  // The app's scope sorts on either side of `@ultimat3`, and the formatter orders by specifier.
  test('an entity import sorts by its specifier, on either side of the framework imports', () => {
    const entry = (app: string) =>
      handleEntryFor('post', {
        surfaceDir: 'apps/web/app',
        feature: 'post',
        dbModule: `@${app}/db`,
      });
    const linesOf = (app: string) =>
      dbClientSource([entry(app)])
        .split('\n')
        .filter((line) => line.startsWith('import '));
    expect(linesOf('alpha')[0]).toContain("'@alpha/web/app/post/entity'");
    expect(linesOf('zeta').at(-1)).toContain("'@zeta/web/app/post/entity'");
  });

  test('an entry names the table as the repo reads it, and the module the entity lives in', () => {
    const target = { surfaceDir: 'apps/web/site', feature: 'billing', dbModule: '@shop/db' };
    expect(handleEntryFor('credit-note', target)).toEqual({
      key: 'creditNotes',
      binding: 'creditNote',
      specifier: '@shop/web/site/billing/entity',
    });
    expect(webModuleOf('@shop/db')).toBe('@shop/web');
  });
});
