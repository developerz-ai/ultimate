/**
 * One printed statement of a connection's accounts page: `scrape()` opens it, `page.pdf()` lays it
 * out on A4 with margins and a page-number footer, and the bytes land on the org's disk. A job
 * FACTORY, so this is a `job`, nothing more. No sign-in: a page a secret was typed into refuses
 * `pdf()` (`X_SCRAPE_SECRET_EXPOSED`), so a statement is printed from a page that holds none.
 *
 * The site is the same RECORDING `syncConnection` replays (`../fixtures`): the offline driver
 * answers a deterministic PDF per layout, so the layout below is what its test pins.
 */

import { type Infer, t } from '@ultimat3/jobs';
import type { PdfRequest, ScrapePage } from '@ultimat3/scraping';
import { fixtureBrowser, scrape } from '@ultimat3/scraping';
import type { StorageDriver } from '@ultimat3/storage';
import { disk, scopedKey } from '@ultimat3/storage';
import { ACCOUNTS, SITE } from './sync-connection';

/** A4, 15mm all round, backgrounds kept, and `n / total` in the footer — an invoice's page. */
export const STATEMENT_LAYOUT: PdfRequest = {
  format: 'a4',
  marginMm: { top: 15, right: 15, bottom: 15, left: 15 },
  printBackground: true,
  footerHtml: '<span class="pageNumber"></span> / <span class="totalPages"></span>',
};

const StatementInput = t.object({ orgId: t.uuid, requestId: t.uuid });

type StatementInput = Infer<typeof StatementInput>;

const Statement = t.object({ key: t.string, bytes: t.number.int() });

type Statement = Infer<typeof Statement>;

/** Print the accounts page and store it under the org's own key. */
export async function printAccounts(
  page: ScrapePage,
  store: StorageDriver,
  input: StatementInput,
): Promise<Statement> {
  await page.goto(ACCOUNTS);
  const pdf = await page.pdf(STATEMENT_LAYOUT);
  const key = scopedKey(input.orgId, 'statements', `${input.requestId}.pdf`);
  await store.put(key, pdf, { contentType: 'application/pdf' });
  return { key, bytes: pdf.byteLength };
}

export const printStatement = scrape({
  name: 'runs.statement',
  input: StatementInput,
  extract: Statement,
  idempotencyKey: ({ requestId }) => `runs.statement:${requestId}`,
  tenant: ({ orgId }) => orgId,
  allowHosts: [SITE],
  driver: fixtureBrowser(`${import.meta.dir}/../fixtures`),
  robots: { ignore: 'a recorded site: there is no origin to ask' },
  async run({ input, page }) {
    return [await printAccounts(page, disk(), input)];
  },
});
