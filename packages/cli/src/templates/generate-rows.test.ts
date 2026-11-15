// `x g export-rows` / `x g import-rows` move the slice's own scaffolded table, so a slice whose
// entity is shaped otherwise is refused before a file is planned — the case that, for `backfill`,
// once imported a row type and a db handle that did not exist.

import { describe, expect, test } from 'bun:test';
import { UltimateError } from '@ultimat3/core';
import { generate } from '../generate-files';
import { HANDWRITTEN_ENTITY_NO_TENANT, INVOICE_ENTITY } from '../scaffold-fixture';

const thrownBy = (run: () => unknown): UltimateError => {
  try {
    run();
  } catch (error) {
    if (error instanceof UltimateError) return error;
  }
  return expect.unreachable('nothing was thrown');
};

describe('unit · x g export-rows · import-rows', () => {
  for (const kind of ['export-rows', 'import-rows'] as const) {
    test(`${kind} into a slice shaped otherwise is refused, naming its tables`, () => {
      const thrown = thrownBy(() =>
        generate({
          kind,
          name: 'move-links',
          feature: 'short-link',
          sliceEntity: HANDWRITTEN_ENTITY_NO_TENANT,
        }),
      );
      expect(thrown.code).toBe('X_ROWS_SLICE_ENTITY');
      expect(thrown.cause).toContain('short_links');
      expect(thrown.fix).toStartWith('x g job move-links --feature short-link');
    });

    test(`${kind} into the scaffolded slice writes the call and its two suites, and no entity`, () => {
      const files = generate({
        kind,
        name: 'move-invoices',
        feature: 'invoice',
        sliceEntity: INVOICE_ENTITY,
      });
      const paths = files.map((file) => file.path);
      expect(paths).toContain('apps/web/app/invoice/jobs/move-invoices.ts');
      expect(paths).toContain('apps/web/app/invoice/jobs/move-invoices.job.test.ts');
      expect(paths).toContain('apps/web/app/invoice/jobs/move-invoices.test.ts');
      const source = String(
        files.find((file) => file.path.endsWith('/move-invoices.ts'))?.contents,
      );
      expect(source).toContain('tenant: ({ orgId }) => orgId');
      expect(source).toContain('db.invoices');
    });
  }

  // A draw names an upload key no object sits at, so the import is off in `x exercise` — with its
  // why — rather than an unreached job that reds the exercise step on every app that runs x g.
  test('import-rows declares its exercise entry off, with a why', () => {
    const files = generate({ kind: 'import-rows', name: 'import-invoices', feature: 'invoice' });
    const entries = files.flatMap((file) =>
      'exercise' in file && file.exercise !== undefined ? [file.exercise] : [],
    );
    expect(entries.map((entry) => entry.name)).toEqual(['import-invoices']);
    expect(entries[0]?.value).toContain("off: 'reads an uploaded object");
  });

  // The upload key is the caller's: without this refine, org A imports org B's file under A.
  test('import-rows holds the upload key to the run org, and its suite proves the refusal', () => {
    const files = generate({ kind: 'import-rows', name: 'import-invoices', feature: 'invoice' });
    const text = (suffix: string): string =>
      String(files.find((file) => file.path.endsWith(suffix))?.contents);
    expect(text('/import-invoices.ts')).toContain(
      "check: ({ orgId, key }) => key.startsWith(importInvoicesPrefix(orgId)) && !key.includes('..')",
    );
    expect(text('/import-invoices.test.ts')).toContain(
      "expect(run?.outcome).toBe('dead-lettered');",
    );
  });

  test('the export names exactly the columns its row answers', () => {
    const files = generate({ kind: 'export-rows', name: 'export-invoices', feature: 'invoice' });
    const source = String(
      files.find((file) => file.path.endsWith('/export-invoices.ts'))?.contents,
    );
    const listed = /Columns = \[([^\]]*)\]/.exec(source)?.[1]?.match(/'([^']+)'/g) ?? [];
    const row = /Row = \(row: [A-Za-z]+\) => \(\{([^}]*)\}\)/.exec(source)?.[1] ?? '';
    const keys = [...row.matchAll(/^\s*([a-zA-Z]+):/gm)].map((match) => `'${match[1]}'`);
    expect(listed).toHaveLength(5);
    expect(keys).toEqual(listed);
  });
});
