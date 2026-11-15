// 31.27.0: every scaffold ships a `live` suite (the production driver against a real Postgres) and,
// where it serves a page, an `e2e` suite (the landing page in a real browser). An app that predates
// them gains each, as `x new` writes it today; one it already holds is its own.

import {
  E2E_SUITE_PATH,
  e2eSuiteFiles,
  LIVE_SUITE_PATH,
  liveSuiteFiles,
} from '../templates/scaffold-suites';
import type { Codemod, CodemodApp, CodemodResult } from './codemod';
import { mergeResults, writeIfAbsent } from './engine-edits';

const NOTHING: CodemodResult = { changed: [], skipped: [] };

/** Each suite lands beside what it drives: no db package, no live suite; no landing page, no e2e. */
const HOSTS: readonly (readonly [string, string])[] = [
  [LIVE_SUITE_PATH, 'packages/db/src/index.ts'],
  [E2E_SUITE_PATH, 'apps/web/site/page.tsx'],
];

async function suite(app: CodemodApp, path: string, host: string): Promise<CodemodResult> {
  if (!(await app.exists(host))) return NOTHING;
  const file = [...liveSuiteFiles(), ...e2eSuiteFiles()].find((one) => one.path === path);
  return typeof file?.contents === 'string' ? writeIfAbsent(app, path, file.contents) : NOTHING;
}

export const codemod: Codemod = {
  id: 'test-suites',
  since: '31.27.0',
  summary: `the live and e2e suites every scaffold ships: ${LIVE_SUITE_PATH} and ${E2E_SUITE_PATH}`,
  async run(app) {
    const results: CodemodResult[] = [];
    for (const [path, host] of HOSTS) results.push(await suite(app, path, host));
    return mergeResults(results);
  },
};
