// 31.27.0: every scaffold ships a `live` suite (the production driver against a real Postgres) and,
// where it serves a page, an `e2e` suite (the landing page in a real browser; `e2e-suite.ts` picks
// the page for an app with none). An app that predates them gains each; one it holds is its own.

import { LIVE_SUITE_PATH, liveSuiteFiles } from '../templates/scaffold-suites';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { e2eSuitePlan, writeE2eSuite } from './e2e-suite';
import { mergeResults, writeIfAbsent } from './engine-edits';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** No db package, no live suite: it lands beside the handle it vouches for. */
async function liveSuite(app: CodemodApp): Promise<CodemodResult> {
  if (!(await app.exists('packages/db/src/index.ts'))) return NOTHING;
  const contents = liveSuiteFiles()[0]?.contents;
  return typeof contents === 'string' ? writeIfAbsent(app, LIVE_SUITE_PATH, contents) : NOTHING;
}

export const codemod: Codemod = {
  id: 'test-suites',
  since: '31.27.0',
  summary: `the live and e2e suites every scaffold ships: ${LIVE_SUITE_PATH} and a page's *.e2e.test.ts`,
  async run(app) {
    return mergeResults([await liveSuite(app), await writeE2eSuite(app, await e2eSuitePlan(app))]);
  },
};
