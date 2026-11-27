// What a merge left behind, as findings: paths git still holds unmerged, and i18n catalogs that do
// not parse. A catalog is imported by nearly every page, so one stray marker used to surface as a
// SyntaxError blamed on each importer, with the catalog itself named nowhere.

// why: `Bun.Glob.scan` throws on a missing directory, and an app need not have any catalog.
import { existsSync } from 'node:fs';
import { ERROR_DOCS_URL, renderThrowable } from '@ultimat3/core';
import type { Runner } from './exec';
import { exec } from './exec';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/**
 * `templates/locales.ts`'s `CATALOG_ROOT`, restated: `loadApp` reaches this module, and the serve
 * graph carries no template (`serve-graph.test.ts`). `merge-state.test.ts` holds the two equal.
 */
export const CATALOG_ROOT = 'packages/i18n/catalogs';

export const UNMERGED_FIX = 'git diff --name-only --diff-filter=U';

const MARKER = /^(?:<{7}|\|{7}|={7}|>{7})(?: |$)/m;

const finding = (code: string, cause: string, fix: string, at: string): Finding => ({
  code,
  cause,
  fix,
  docs: ERROR_DOCS_URL,
  at,
});

/** Every path git holds unmerged, relative to `root`; none outside a checkout. */
export async function unmergedPaths(
  root: string,
  runner: Runner = exec,
): Promise<readonly string[]> {
  const argv = ['git', 'diff', '--name-only', '--relative', '--diff-filter=U'];
  const found = await runner(argv, { cwd: root }).catch(() => undefined);
  if (found?.ok !== true) return [];
  return found.stdout.split('\n').filter((path) => path !== '');
}

export async function unmergedFindings(root: string, runner?: Runner): Promise<readonly Finding[]> {
  return (await unmergedPaths(root, runner)).map((path) =>
    finding(
      'X_MERGE_UNRESOLVED',
      `${path} is still unmerged: git holds conflicting versions of it`,
      UNMERGED_FIX,
      path,
    ),
  );
}

/** One finding per catalog that will not load, naming the file every importer failed on. */
export async function catalogFileFindings(root: string): Promise<readonly Finding[]> {
  const findings: Finding[] = [];
  const directory = `${root}/${CATALOG_ROOT}`;
  if (!existsSync(directory)) return findings;
  // `**`: a split locale's namespace files (`en/billing.json`) are imported by every page too.
  for await (const name of new Bun.Glob('**/*.json').scan(directory)) {
    const at = `${CATALOG_ROOT}/${name.replaceAll('\\', '/')}`;
    const text = await Bun.file(`${root}/${at}`).text();
    if (MARKER.test(text)) {
      findings.push(
        finding(
          'X_MERGE_UNRESOLVED',
          `${at} holds conflict markers, so it is not JSON and no page importing it loads`,
          `grep -nE '^(<{7}|={7}|>{7})' ${quoteArg(at)}   # keep the right side of each, delete the markers`,
          at,
        ),
      );
      continue;
    }
    try {
      JSON.parse(text);
    } catch (error) {
      findings.push(
        finding(
          'X_CATALOG_UNPARSEABLE',
          `${at} is not valid JSON (${renderThrowable(error)}), so no page importing it loads`,
          `bunx biome check ${quoteArg(at)}   # names the line to correct`,
          at,
        ),
      );
    }
  }
  return findings;
}

const isCatalogSymptom = (one: Finding): boolean =>
  one.code === 'X_CLI_UNEXPECTED' && one.cause.includes('JSON Parse error');

/**
 * A failed app load, its causes first: an unparseable catalog replaces the parse errors it caused
 * in every importer, and an unmerged path leads, because it explains whatever else failed. Asked
 * only once the load has already failed, so a healthy app pays nothing.
 */
export async function withMergeCauses(
  root: string,
  findings: readonly Finding[],
): Promise<readonly Finding[]> {
  const catalogs = await catalogFileFindings(root);
  const held = new Set(catalogs.map((one) => one.at));
  const unmerged = (await unmergedFindings(root)).filter((one) => !held.has(one.at));
  const rest = catalogs.length > 0 ? findings.filter((one) => !isCatalogSymptom(one)) : findings;
  return [...unmerged, ...catalogs, ...rest];
}
