// The statement's layout reaches the page, and the bytes land under the org's own key. Over the
// fake driver, which answers different deterministic bytes per layout — so a dropped margin or
// format is a failing test here, not a wrong invoice later.

import { fakePage } from '@ultimat3/scraping';
import { memoryStorageDriver } from '@ultimat3/storage';
import { expect, unitTest } from '@ultimat3/testing';
import { printAccounts, printStatement, STATEMENT_LAYOUT } from './print-statement';
import { ACCOUNTS } from './sync-connection';

const ORG = '00000000-0000-4000-8000-0000000000a1';
const REQUEST = '00000000-0000-4000-8000-0000000000c1';

unitTest('a statement is one job per request, in the org its input names', () => {
  expect(printStatement.name).toBe('runs.statement');
  expect(printStatement.idempotencyKeyFor({ orgId: ORG, requestId: REQUEST })).toBe(
    `runs.statement:${REQUEST}`,
  );
  expect(printStatement.tenantFor({ orgId: ORG, requestId: REQUEST })).toBe(ORG);
});

unitTest('the accounts page is printed on A4 with its margins and stored as a PDF', async () => {
  const page = fakePage('<p>start</p>', {
    pages: [{ url: ACCOUNTS, html: '<ul><li>Operating</li></ul>' }],
  });
  const store = memoryStorageDriver({ signingSecret: 'test-secret' });
  const statement = await printAccounts(page, store, { orgId: ORG, requestId: REQUEST });

  const stored = await store.get(statement.key);
  expect(stored.object.contentType).toBe('application/pdf');
  expect(statement.key.endsWith(`/statements/${REQUEST}.pdf`)).toBe(true);
  const text = new TextDecoder().decode(stored.bytes);
  expect(text.startsWith('%PDF-')).toBe(true);
  // The offline driver stamps the layout it was handed: the request reached the port whole.
  expect(text).toContain('format=a4');
  expect(text).toContain('marginMm=15/15/15/15');
  expect(text).toContain('printBackground=true');
  expect(STATEMENT_LAYOUT.footerHtml).toContain('pageNumber');
});
