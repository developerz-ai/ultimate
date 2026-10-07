// A `defineAdmin()` the app scan never imports. The admin's one home is `apps/admin/app/admin/`
// (`ADMIN_FILE`, what `x new` and `x g admin:page` write); `apps/<app>/src/` is outside every
// glob `app-load.ts` imports, so a declaration there never runs and `/admin` is never mounted —
// silently, which is how the reference app shipped an admin nobody could open.

import { renderFixShellArg, stripComments } from '@ultimat3/core';
import { describePages } from '@ultimat3/render';
import { ADMIN_FILE } from './admin-registration';
import type { Finding } from './output';
import { hasPathSegment } from './path-segments';
import { isTest } from './source-files';

/** The one place an admin used to be written that the scan cannot see. */
const UNSCANNED = 'apps/*/src/**/*.{ts,tsx}';

const DECLARES = /\bdefineAdmin\(/;

/** Any admin this process mounted — then every declaration was reached, wherever it sits. */
export const adminMounted = (): boolean =>
  describePages().some((route) => route.mount?.by === 'defineAdmin');

/** Where the file belongs: its own name under the admin's home, `index.ts` as the declaration. */
const homeOf = (file: string): string => {
  const name = file.slice(file.lastIndexOf('/') + 1);
  const home = ADMIN_FILE.slice(0, ADMIN_FILE.lastIndexOf('/'));
  return /^index\.tsx?$/.test(name) ? ADMIN_FILE : `${home}/${name}`;
};

const unscannedFinding = (file: string): Finding => ({
  code: 'X_ADMIN_UNSCANNED',
  cause: `${file} calls defineAdmin(), and the app scan imports apps/*/{site,app,api,shared}/** only — no boot evaluates it, so the admin is never mounted and /admin answers 404`,
  // A file name is the app's: screened, so a name carrying shell syntax reads as a placeholder.
  fix: `git mv ${renderFixShellArg(file, '<the file above>')} ${renderFixShellArg(homeOf(file), '<apps/admin/app/admin/its-name.ts>')}   # then repoint its relative imports and x verify --only manifest --json`,
  at: file,
});

/**
 * One finding per unscanned file that declares an admin. Read only when nothing mounted one: an app
 * whose admin is mounted pays for no glob, and comments are masked so prose naming the call is not
 * a declaration.
 */
export async function unscannedAdminFindings(
  root: string,
  mounted: () => boolean = adminMounted,
): Promise<readonly Finding[]> {
  if (mounted()) return [];
  const files: string[] = [];
  for await (const file of new Bun.Glob(UNSCANNED).scan({ cwd: root })) {
    const path = file.replaceAll('\\', '/');
    if (hasPathSegment(path, 'node_modules') || isTest(path)) continue;
    if (DECLARES.test(stripComments(await Bun.file(`${root}/${path}`).text()))) files.push(path);
  }
  return files.sort().map(unscannedFinding);
}
