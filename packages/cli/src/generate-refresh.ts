// Whether an `x g` run's files can change a fact `x.manifest.json` holds — and so whether the run
// has to load the whole app to re-project it. Every manifest fact is read off a registry the app
// scan fills, except the `X_*` codes, which are read off the source: a file the scan never imports
// and that declares no code cannot move either, so the run skips the load (plan 101, slice 22 B5).

// why: Bun ships no path API; the scan's own rule takes an absolute path.
import { resolve } from 'node:path';
import { isAppModulePath } from './app-load';
import { isTest } from './source-files';
import { scanCodes } from './ts-scan';

/** Source the codes walk reads; anything else is data, a stylesheet or a doc. */
const SOURCE = /\.[cm]?[jt]sx?$/;

/**
 * Whether one written or edited file can change the manifest. Unreadable (a dry run's planned file
 * is not on disk) is answered from `planned` when the caller has its bytes, and is `true` when it
 * has none: a refresh too many costs seconds, one too few is a stale contract.
 */
async function moves(
  root: string,
  path: string,
  planned: ReadonlyMap<string, string>,
): Promise<boolean> {
  // The app root's own files — `package.json`, `app.config.ts` — are the manifest's identity.
  if (!path.includes('/')) return true;
  // Neither imported nor walked for codes (`collectDeclaredCodes` skips them too).
  if (isTest(path)) return false;
  if (isAppModulePath(root, path)) return true;
  if (!SOURCE.test(path)) return !/\.(?:s?css|md|json)$/.test(path);
  const text =
    planned.get(path) ??
    (await Bun.file(resolve(root, path))
      .text()
      .catch(() => undefined));
  return text === undefined || scanCodes(text, path).length > 0;
}

/**
 * Whether any of `paths` (app-root-relative) can change `x.manifest.json`. A `.json` file is no
 * manifest input: a catalog's keys are not in it, and a workspace manifest's edit always arrives
 * with the module whose import it declares.
 */
export async function manifestCanChange(
  root: string,
  paths: readonly string[],
  planned: ReadonlyMap<string, string> = new Map(),
): Promise<boolean> {
  for (const path of paths) {
    if (await moves(root, path, planned)) return true;
  }
  return false;
}
