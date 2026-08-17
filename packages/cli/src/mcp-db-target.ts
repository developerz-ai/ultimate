// Which database the MCP dev host is pointed at: whether it is a branch, and whether this is
// production. `db.migrate` decides from these two alone, so both readings have to be exact — a
// wrong `branch` is a migration against a database somebody else is using, and a `production` that
// is always false is a refusal that never runs.

import { join } from 'node:path';
import { tryResolveEnvironment } from '@ultimat3/core';
import { pgliteDataDir } from '@ultimat3/db';
import type { DatabaseTarget } from '@ultimat3/mcp';
import { branchNameOf, pgliteBranchName } from './db-branch';
import type { DevServices, Env } from './dev-services';
import { safeUrlLabel } from './safe-url-label';

/**
 * `production` was the literal `false` in both arms until `As of 2026-08`, and this is the only
 * place a `DatabaseTarget` is ever built — so `assertBranchDatabase`'s FIRST refusal, the one
 * meaning "production is never migratable from MCP at all", could not run for any database this
 * CLI produced. A production database refused it only incidentally, because its name lacked
 * `_branch_`; one named `shop_branch_hotfix`, or a container whose data directory is
 * `pgdata-hotfix`, read as a branch and was migratable through an MCP tool call.
 *
 * The environment is read the way `x doctor` reads it (`cmd-doctor.ts`), through core's one key —
 * so `production` is a fact about the deploy and `branch` stays a fact about the database, and
 * `@ultimat3/mcp` keeps receiving two answers rather than re-deriving either.
 */
export function databaseTarget(services: DevServices, env: Env): DatabaseTarget {
  const url = services.db.url;
  const production = isProduction(env);
  return services.db.mode === 'embedded'
    ? { label: url, branch: pgliteBranch(url, services.stateDir), production }
    : {
        // An external `DATABASE_URL` may carry credentials, and this string gets printed.
        label: safeUrlLabel(url, 'external database'),
        branch: postgresBranch(url),
        production,
      };
}

/**
 * The non-throwing read, because `ULTIMATE_ENV` is in no env schema — nothing validates it at boot,
 * and a tool call is not where a typo should surface as a crash (`cmd-doctor.ts` chose the same
 * variant for the same reason).
 *
 * `undefined` is answered **true**, and that is the whole point of using it here. It means exactly
 * one thing: `ULTIMATE_ENV` is set to something that is not an environment. Reading a typo as "not
 * production" would let the single misconfiguration this guard exists to survive defeat it — so an
 * environment that cannot be read is treated as the most dangerous one it could be.
 */
const isProduction = (env: Env): boolean => {
  const environment = tryResolveEnvironment({ env });
  return environment === undefined || environment === 'production';
};

/**
 * `x db branch create <name>` names an external clone `<source>_branch_<name>`. Both readings come
 * from `db-branch.ts` — the module that also WRITES those names — because a target that disagrees
 * with `x db branch ls` about what a branch is would let `db.migrate` run against a shared
 * database on the strength of a naming rule one of the two had drifted away from.
 */
function postgresBranch(url: string): string | null {
  let database: string;
  try {
    database = new URL(url).pathname.replace(/^\//, '');
  } catch {
    return null;
  }
  return branchNameOf(database);
}

/** `branchPglite` copies `<stateDir>/pgdata` to `<stateDir>/pgdata-<name>`; the dev dir is no branch. */
function pgliteBranch(url: string, stateDir: string): string | null {
  return pgliteBranchName(pgliteDataDir(url), join(stateDir, 'pgdata'));
}
