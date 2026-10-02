// What `x g entity` and `x g resource` emit for data access: a repo over the typed handle. The
// generator is the documentation — an agent copies what it writes — so string SQL in it is string
// SQL in every app that starts from it.

import { describe, expect, test } from 'bun:test';
import { stripComments } from '@ultimat3/core';
import type { GenerateOptions } from '../cmd-generate';
import { generate } from '../cmd-generate';
import { PLACEHOLDER_DB_MODULE } from './scaffold-db-client';
import { LINE_WIDTH } from './wrap';

const DB = '@ledger/db';

const emitted = (options: GenerateOptions): ReadonlyMap<string, string> =>
  new Map(generate(options).map((file) => [file.path, String(file.contents)]));

const fileOf = (options: GenerateOptions, path: string): string => emitted(options).get(path) ?? '';

describe('unit · x g entity · the repo reads through the typed handle', () => {
  const repo = fileOf(
    { kind: 'entity', name: 'widget', dbModule: DB },
    'apps/web/app/widget/repo.ts',
  );

  test('no sql literal, no row decoding, no tenant predicate in SQL — comments included', () => {
    expect(repo).not.toBe('');
    expect(repo).not.toContain('sql`');
    expect(repo).not.toContain('decodeRow');
    expect(repo).not.toContain('org_id');
    expect(repo).not.toContain('@ultimat3/db');
    expect(repo).not.toContain('@ultimat3/entity');
  });

  test('its three functions are handle calls', () => {
    const code = stripComments(repo);
    expect(code).toContain(`import { db } from '${DB}';`);
    expect(code).toContain('(await db.widgets.where({ id }).one()) ?? undefined');
    expect(code).toContain("db.widgets.orderBy('createdAt', 'desc').limit(limit).all()");
    expect(code).toContain('db.widgets.insert(row)');
  });

  test('the handle is keyed by the plural the registrar writes, whatever the name', () => {
    const long = fileOf(
      {
        kind: 'entity',
        name: 'customer-credit-note-attachment-revision-log-entry',
        dbModule: DB,
      },
      'apps/web/app/customer-credit-note-attachment-revision-log-entry/repo.ts',
    );
    expect(long).toContain('db.customerCreditNoteAttachmentRevisionLogEntries');
    // The chain no longer fits one line, so it is emitted the way the formatter breaks it.
    expect(long).toContain(
      "  return db.customerCreditNoteAttachmentRevisionLogEntries\n    .orderBy('createdAt', 'desc')\n    .limit(limit)",
    );
    for (const line of stripComments(long).split('\n')) {
      // Comments are masked to blanks, not removed: only the code a formatter measures counts.
      expect(line.trimEnd().length).toBeLessThanOrEqual(LINE_WIDTH);
    }
  });

  test('a pure call that names no app writes the placeholder, never a guess at one', () => {
    expect(fileOf({ kind: 'entity', name: 'widget' }, 'apps/web/app/widget/repo.ts')).toContain(
      `import { db } from '${PLACEHOLDER_DB_MODULE}';`,
    );
  });
});

describe('unit · x g entity · every emitted module has a test that loads it', () => {
  test('repo.test.ts rides beside repo.ts and resets the store the repo reads', () => {
    const files = emitted({ kind: 'entity', name: 'widget', dbModule: DB });
    expect([...files.keys()]).toEqual([
      'apps/web/app/widget/entity.ts',
      'apps/web/app/widget/entity.test.ts',
      'apps/web/app/widget/repo.ts',
      'apps/web/app/widget/repo.test.ts',
      // The labels the admin reads for the new screen — `admin-catalog.ts`.
      'packages/i18n/catalogs/en.json',
    ]);
    const test = files.get('apps/web/app/widget/repo.test.ts') ?? '';
    expect(test).toContain(`import { driver } from '${DB}';`);
    expect(test).toContain('driver.reset?.()');
    for (const call of ['repo.byId(', 'repo.list(', 'repo.insert(']) expect(test).toContain(call);
  });

  test('a row is compared with toEqualRow: toEqual cannot see a sealed column', () => {
    const files = emitted({ kind: 'resource', name: 'widget', dbModule: DB });
    for (const path of [
      'apps/web/app/widget/repo.test.ts',
      'apps/web/app/widget/service.test.ts',
    ]) {
      const code = stripComments(files.get(path) ?? '');
      expect(code).toContain('.toEqualRow(');
      expect(code).not.toMatch(/\.toEqual\((stored|created)\)/);
    }
  });
});

describe('unit · x g resource · the slice it composes reads one handle', () => {
  const files = emitted({ kind: 'resource', name: 'invoice', dbModule: DB });

  test('the app db package reaches every module that names one — none takes the placeholder', () => {
    const naming = [...files].filter(([, contents]) => contents.includes("/db'"));
    // At least the repo, its test and the tests that reset the store — other templates add theirs.
    for (const path of [
      'apps/web/app/invoice/repo.ts',
      'apps/web/app/invoice/repo.test.ts',
      'apps/web/app/invoice/actions/create-invoice.test.ts',
      'apps/web/app/invoice/actions/archive-invoice.test.ts',
      'apps/web/app/invoice/service.test.ts',
    ]) {
      expect(naming.map(([file]) => file)).toContain(path);
    }
    for (const [, contents] of naming) expect(contents).not.toContain(PLACEHOLDER_DB_MODULE);
  });

  test('service.ts and both components come with the test that covers them', () => {
    const service = files.get('apps/web/app/invoice/service.test.ts') ?? '';
    expect(service).toContain("import { create, requireInvoice } from './service';");
    expect(service).toContain("toBeUltimateError('X_INVOICE_NOT_FOUND')");
    const ui = files.get('apps/web/app/invoice/ui.test.ts') ?? '';
    // Rendered through the test kit: no dynamic import, no cast between two JSX type worlds.
    expect(ui).toContain("import { InvoiceList } from './ui';");
    expect(ui).toContain("import { InvoiceCard } from './ui/invoice-card';");
    expect(ui).toContain('await renderView(InvoiceList, { rows })');
    expect(ui).not.toContain('as unknown as');
  });

  test('both actions arrive with a unit test that runs the handler', () => {
    const archive = files.get('apps/web/app/invoice/actions/archive-invoice.test.ts') ?? '';
    expect(archive).toContain("toBeUltimateError('X_INVOICE_NOT_FOUND')");
    expect(archive).toContain('repo.insert(draft)');
    const create = files.get('apps/web/app/invoice/actions/create-invoice.test.ts') ?? '';
    expect(create).toContain('await target.as(writer, input)');
    expect(create).toContain("toBeUltimateError('X_TENANCY_ACTOR_ORG_REQUIRED')");
    // The guard is a function the test can call: a branch only the policy could reach is a
    // branch no unit test covers.
    const source = files.get('apps/web/app/invoice/actions/create-invoice.ts') ?? '';
    expect(source).toContain('orgId: orgOf(ctx.actor)');
  });

  test('x g action stores a row only in a slice whose columns are the scaffold own', () => {
    const entity = files.get('apps/web/app/invoice/entity.ts') ?? '';
    const into = (sliceEntity: string): string =>
      emitted({
        kind: 'action',
        name: 'send-invoice',
        feature: 'invoice',
        sliceEntity,
        dbModule: DB,
      }).get('apps/web/app/invoice/actions/send-invoice.test.ts') ?? '';
    // The entity `x g entity` wrote, untouched: the row is one this generator can spell, so the
    // test runs the handler's found-row branch too.
    expect(into(entity)).toContain('repo.insert(draft)');
    // One more required column and it is the author's table: never inserted into, and the
    // refusal branch — which needs no row — is still run.
    const authored = entity.replace(
      '    price: money(',
      '    body: text({ max: 4000 }),\n    price: money(',
    );
    expect(authored).not.toBe(entity);
    expect(into(authored)).not.toContain('repo.insert');
    expect(into(authored)).toContain("toBeUltimateError('X_INVOICE_NOT_FOUND')");
  });

  test('the live list pages through the repo, which is the handle', () => {
    const live = files.get('apps/web/app/invoice/live/invoice-list.ts') ?? '';
    expect(live).toContain("import * as repo from '../repo';");
    expect(live).not.toContain('sql`');
  });
});
