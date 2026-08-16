// Which database the MCP dev host is pointed at, and whether that database is a branch. `db.migrate`
// decides from this alone, so the reading has to be exact: a wrong `branch` is a migration against a
// database somebody else is using.

import { basename, join } from 'node:path';
import { pgliteDataDir } from '@ultimat3/db';
import type { DatabaseTarget } from '@ultimat3/mcp';
import type { DevServices } from './dev-services';
import { safeUrlLabel } from './safe-url-label';

/**
 * `production` is always false: this target is whatever `x dev` resolved — embedded PGlite under
 * `.x/`, or the `DATABASE_URL` of a developer's shell. Production is reached through `ROLE=migrate`
 * in a deploy hook, never through MCP. What actually stops a migration against a shared database is
 * `branch`, which is null unless the name says otherwise.
 */
export function databaseTarget(services: DevServices): DatabaseTarget {
  const url = services.db.url;
  return services.db.mode === 'embedded'
    ? { label: url, branch: pgliteBranch(url, services.stateDir), production: false }
    : {
        // An external `DATABASE_URL` may carry credentials, and this string gets printed.
        label: safeUrlLabel(url, 'external database'),
        branch: postgresBranch(url),
        production: false,
      };
}

/** `x db branch <name>` names an external clone `<source>_branch_<name>` (`branchDatabaseName`). */
function postgresBranch(url: string): string | null {
  let database: string;
  try {
    database = new URL(url).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
  return /_branch_(.+)$/.exec(database)?.[1] ?? null;
}

/** `branchPglite` copies `<stateDir>/pgdata` to `<stateDir>/pgdata-<name>`; the dev dir is no branch. */
function pgliteBranch(url: string, stateDir: string): string | null {
  const dir = pgliteDataDir(url);
  const dev = join(stateDir, 'pgdata');
  if (dir === dev || basename(dir) === basename(dev)) return null;
  return dir.startsWith(`${dev}-`) ? dir.slice(dev.length + 1) : null;
}
