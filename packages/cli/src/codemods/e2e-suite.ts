// Whether this app's `e2e` step has a suite to run, and if not which one a codemod can write: the
// one answer the suite codemods and the floor codemods share, so the floor never requires a suite
// nothing created (`X_VERIFY_SUITE_VANISHED`). Only `apps/web` is here: the page the step boots.

import { isJsonObject } from '@ultimat3/core';
import { routePathFromFile } from '@ultimat3/render';
import { E2E_SUITE_PATH, e2eSuiteFiles, pageE2eSuite } from '../templates/scaffold-suites';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import { ownerOf } from '../verify-test-command';
import type { CodemodApp, CodemodResult } from './codemod';
import { writeIfAbsent } from './engine-edits';

export type E2eSuitePlan =
  /** The app already holds an e2e test: the step has something to run. */
  | { readonly kind: 'held' }
  | { readonly kind: 'write'; readonly path: string; readonly contents: string }
  /** Nothing to run and nothing to write; `pages` says whether the app serves any page at all. */
  | { readonly kind: 'none'; readonly pages: boolean };

const LANDING_PAGE = 'apps/web/site/page.tsx';

/** Why `e2e` is excused for an app whose every page needs a value in its URL. */
export const NO_STATIC_PAGE_WHY =
  'every page here needs a URL parameter, so no suite could be written for one: add a *.e2e.test.ts that visits a real URL, and then e2e moves from "skip" to "steps"';

/** A URL that names itself and is safe inside the suite's quotes: no `:param`, no `*rest`. */
const STATIC_URL = /^\/[\w./~-]*$/;

const holdsE2eTest = async (app: CodemodApp): Promise<boolean> =>
  (await app.glob('{apps,packages,e2e}/**/*.test.{ts,tsx}')).some(
    (path) => !path.includes('/node_modules/') && ownerOf(path) === 'e2e',
  );

/** Whether the floor already excuses `e2e`: the app's decision, which no suite overrides. */
async function floorExcusesE2e(app: CodemodApp): Promise<boolean> {
  try {
    const floor: unknown = JSON.parse((await app.read(VERIFY_FLOOR_FILE)) ?? 'null');
    return isJsonObject(floor) && isJsonObject(floor['skip']) && 'e2e' in floor['skip'];
  } catch {
    // Unreadable is `verify-floor-skips`' to report, and it excuses nothing.
    return false;
  }
}

/** The landing page's suite, else one for the shortest URL `apps/web` serves with no parameter. */
export async function e2eSuitePlan(app: CodemodApp): Promise<E2eSuitePlan> {
  if (await app.exists(LANDING_PAGE)) {
    const contents = e2eSuiteFiles()[0]?.contents;
    if (typeof contents === 'string') return { kind: 'write', path: E2E_SUITE_PATH, contents };
  }
  if (await holdsE2eTest(app)) return { kind: 'held' };
  const pages = await app.glob('apps/web/{site,app}/**/page.tsx');
  const served = (await app.glob('apps/*/{site,app}/**/page.tsx')).length > 0;
  if (await floorExcusesE2e(app)) return { kind: 'none', pages: served };
  const [first] = pages
    .map((file) => ({ file, url: routePathFromFile(file).path }))
    .filter(({ url }) => STATIC_URL.test(url))
    .sort((a, b) => a.url.length - b.url.length || (a.file < b.file ? -1 : 1));
  if (first === undefined) return { kind: 'none', pages: served };
  return {
    kind: 'write',
    path: first.file.replace(/page\.tsx$/, 'page.e2e.test.ts'),
    contents: pageE2eSuite(first.url),
  };
}

/** The plan's file, unless the app already holds that path. */
export const writeE2eSuite = async (app: CodemodApp, plan: E2eSuitePlan): Promise<CodemodResult> =>
  plan.kind === 'write'
    ? writeIfAbsent(app, plan.path, plan.contents)
    : { changed: [], skipped: [] };
