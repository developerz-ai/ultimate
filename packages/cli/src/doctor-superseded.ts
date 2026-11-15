// `x doctor`'s and `x upgrade`'s superseded workarounds: every note in an app's source or docs
// that names a workaround the framework has since retired (`superseded.ts`), as a warning with the
// edit that retires it. A warning and never the verdict: an app that upgrades with no change keeps
// a green doctor on `main` (`X_BREAKING_ON_MAIN`).

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { ERROR_DOCS_URL } from '@ultimat3/core';
import type { Finding } from './output';
import { eachSourceFile, isVendored, sortedPosix } from './source-files';
import type { SupersededWorkaround } from './superseded';
import { SUPERSEDED_WORKAROUNDS } from './superseded';
import type { SupersededHit } from './superseded-match';
import { matchSuperseded } from './superseded-match';

export const SUPERSEDED_WORKAROUND = 'X_SUPERSEDED_WORKAROUND';

/**
 * Beyond the gate's source set: an app's gaps list is markdown, and a hand-written terminator or
 * relay lives in `bin/`, which no gate step reads.
 */
const EXTRA_GLOBS = ['bin/**/*.{ts,tsx}', '*.md', 'docs/**/*.md'] as const;

/** Every file the scan reads: the gate's own source set, then `EXTRA_GLOBS`. */
export async function supersededPaths(root: string): Promise<readonly string[]> {
  const paths: string[] = [];
  for await (const path of eachSourceFile(root)) paths.push(path);
  for (const pattern of EXTRA_GLOBS) {
    const found: string[] = [];
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      if (!isVendored(path)) found.push(path);
    }
    paths.push(...sortedPosix(found));
  }
  return paths;
}

/** One hit as a warning: the cause names the replacement and the version that shipped it. */
export function supersededFinding(hit: SupersededHit, row: SupersededWorkaround): Finding {
  return {
    code: SUPERSEDED_WORKAROUND,
    cause: `${hit.at} keeps the '${row.id}' workaround; ${row.replacement} shipped in ${row.shippedIn}`,
    fix: row.fix,
    docs: ERROR_DOCS_URL,
    at: hit.at.replace(/:\d+$/, ''),
  };
}

/**
 * The seam `x upgrade` calls too: every superseded workaround under `root`, as warnings, in file
 * order. `rows` defaults to the table; a test passes its own.
 */
export async function supersededFindings(
  root: string,
  rows: readonly SupersededWorkaround[] = SUPERSEDED_WORKAROUNDS,
): Promise<readonly Finding[]> {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const findings: Finding[] = [];
  for (const path of await supersededPaths(root)) {
    const text = await Bun.file(join(root, path)).text();
    for (const hit of matchSuperseded(path, text, rows)) {
      const row = byId.get(hit.id);
      if (row !== undefined) findings.push(supersededFinding(hit, row));
    }
  }
  return findings;
}
