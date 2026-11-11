// Generated code survives schema growth: the scaffold's `invoice` entity gains a counter with a
// default and an optional relation, and no generated INSERT site stops compiling. Before the repo's
// insert took `Insertable<typeof invoice.$columns>` it took `Omit<Invoice, 'id' | 'createdAt'>`, and
// the same two columns broke 27 sites in 19 files (measured 2026-11-11).

import { describe, expect, test } from 'bun:test';
import { scaffoldFixture } from './scaffold-fixture';
import { formatDiagnostics, typecheckScaffold } from './scaffold-typecheck-fixture';

const ENTITY = 'apps/web/app/invoice/entity.ts';
const IMPORTS =
  "import { entity, invariant, money, text, timestamp, uuid } from '@ultimat3/entity';";

/** The two columns an app adds first: a counter, and a link to another slice's row. */
const grown = (source: string): string => {
  if (!source.includes(IMPORTS) || !source.includes('    price: money(),\n')) {
    return expect.unreachable(`${ENTITY} no longer has the shape this test grows`);
  }
  return source
    .replace(
      IMPORTS,
      `${IMPORTS.replace('invariant,', 'integer, invariant,')}\nimport { creditNote } from '../credit-note/entity';`,
    )
    .replace(
      '    price: money(),\n',
      '    price: money(),\n    views: integer().default(0),\n    creditNoteId: uuid().nullable().references(() => creditNote.id),\n',
    );
};

/**
 * A full ROW literal (`row(): Invoice`) has to name every column, whatever the declaration
 * defaults: these are the fixtures one per-slice `fixtures.ts` would absorb. Every other site writes
 * through the insert shape and must not notice the growth.
 */
const FULL_ROW_LITERALS = new Set([
  'apps/web/app/invoice/entity.test.ts',
  'apps/web/app/invoice/ui.test.ts',
  'apps/web/app/invoice/backfills/reindex-invoices.test.ts',
]);

describe('contract · generated code survives an added column and relation', () => {
  test('no insert site breaks: only full-row literals name the new columns', async () => {
    const files = scaffoldFixture().map((file) =>
      file.path === ENTITY ? { ...file, contents: grown(String(file.contents)) } : file,
    );
    const report = await typecheckScaffold({ files });
    const surplus = report.diagnostics.filter((one) => !FULL_ROW_LITERALS.has(one.file));
    expect(formatDiagnostics(surplus)).toBe('');
  }, 300_000);
});
