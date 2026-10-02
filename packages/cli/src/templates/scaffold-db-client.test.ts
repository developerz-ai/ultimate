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
