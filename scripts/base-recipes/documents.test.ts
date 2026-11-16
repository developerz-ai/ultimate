// RUNS the PDF-assembly recipe on `wiki/Building-Your-Own-Base.md`: a document declared through the
// app's `documentPdf` prints the route that assembles it, in the house layout, and lands under the
// caller's org on the `documents` disk — gated by its policy, refused for a caller with no org.

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { Action, ActionPolicy } from '@ultimat3/action';
import { registerAction } from '@ultimat3/action/loader';
import { userActor } from '@ultimat3/core';
import { allow, deny } from '@ultimat3/policy';
import { type StandardSchemaV1, t } from '@ultimat3/schema';
import type { PdfLayout, PdfRenderer, PdfRenderRequest } from '@ultimat3/scraping';
import { defineStorage, memoryStorageDriver, resetStorage } from '@ultimat3/storage';
import { exportsOf, type LoadedRecipe, loadRecipe } from '../lib/base-recipes';
import { repoRoot } from '../lib/run';

interface DocumentRecipe {
  readonly HOUSE_LAYOUT: PdfLayout;
  documentPdf(def: {
    kind: string;
    input: StandardSchemaV1<unknown, { readonly id: string }>;
    policy: ActionPolicy;
    route(input: { readonly id: string }): string;
    renderer?: PdfRenderer | undefined;
  }): Action;
}

const BYTES = new TextEncoder().encode('%PDF-1.7 statement');
const seen: PdfRenderRequest[] = [];
const renderer: PdfRenderer = {
  render(request) {
    seen.push(request);
    return Promise.resolve(BYTES);
  },
};
const documents = memoryStorageDriver();
const appUrl = Bun.env['APP_URL'];

let loaded: LoadedRecipe;
let recipe: DocumentRecipe;

beforeAll(async () => {
  loaded = await loadRecipe(repoRoot(), 'apps/web/shared/base/document-pdf.ts');
  recipe = exportsOf<DocumentRecipe>(loaded, ['HOUSE_LAYOUT', 'documentPdf']);
  defineStorage({ disks: { documents } });
  Bun.env['APP_URL'] = 'https://app.test';
});

afterAll(async () => {
  resetStorage();
  if (appUrl === undefined) delete Bun.env['APP_URL'];
  else Bun.env['APP_URL'] = appUrl;
  await loaded.dispose();
});

const statement = (name: string, policy: ActionPolicy) =>
  registerAction(
    name,
    recipe.documentPdf({
      kind: 'statement',
      input: t.object({ id: t.string.min(1) }),
      policy,
      route: ({ id }) => `/statements/${id}/print`,
      renderer,
    }),
  );

const codeOf = async (run: () => Promise<unknown>): Promise<unknown> => {
  try {
    await run();
  } catch (thrown) {
    return (thrown as { code?: unknown }).code;
  }
  return expect.unreachable('expected a refusal');
};

describe('recipe · PDF assembly', () => {
  test('prints the assembling route in the house layout, under the caller’s org', async () => {
    const pdf = statement('statementPdf', allow());
    const answer = await pdf.as(userActor({ id: 'ana', orgId: 'org_1' }), { id: '2026-11' });
    expect(answer).toEqual({
      key: 'org_1/statement/2026-11.pdf',
      bytes: BYTES.byteLength,
      contentType: 'application/pdf',
    });
    expect(seen.at(-1)?.url).toBe('https://app.test/statements/2026-11/print');
    expect(seen.at(-1)?.layout).toMatchObject(recipe.HOUSE_LAYOUT);
    const stored = await documents.get('org_1/statement/2026-11.pdf');
    expect(new TextDecoder().decode(stored.bytes)).toBe('%PDF-1.7 statement');
  });

  test('a caller with no org is the recipe’s own refusal, before a byte lands', async () => {
    const pdf = statement('statementPdfNoOrg', allow());
    expect(await codeOf(() => pdf.as(userActor({ id: 'solo' }), { id: '1' }))).toBe(
      'X_DOCUMENT_ORG_REQUIRED',
    );
  });

  test('the policy refuses before the browser is asked', async () => {
    const before = seen.length;
    const pdf = statement('statementPdfDenied', deny('statement.not-yours'));
    expect(await codeOf(() => pdf.as(userActor({ id: 'eve', orgId: 'org_2' }), { id: '1' }))).toBe(
      'X_FORBIDDEN',
    );
    expect(seen.length).toBe(before);
  });
});
