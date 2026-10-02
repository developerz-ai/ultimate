// `reference-app-gate.ts --app <dir>`: ONE tracked app's build, gate and ratchet, so each app has
// its own CI runner. No flag is every app, in table order — what a contributor runs locally. Pure:
// the caller reads argv and reports.

import { renderFixShellArg } from '../../packages/core/src/error-render';
import { nearestName } from '../../packages/core/src/nearest-name';
import type { GatedApp } from './gated-apps';
import type { Finding } from './log';

const spelled = (dir: string): string => dir.replace(/^\.\//, '').replace(/\/+$/, '');

/**
 * The apps this run gates, or the refusal. A name that is not a gated app is never "no apps": a
 * gate over an empty list passes by checking nothing, which is the one outcome a selector may not
 * have. The fix is a line that runs — the nearest app when the name resembles one, the first
 * otherwise.
 */
export const selectApps = (
  requested: string | boolean | undefined,
  apps: readonly GatedApp[],
): readonly GatedApp[] | Finding => {
  if (requested === undefined) return apps;
  const dirs = apps.map((app) => app.dir);
  const wanted = typeof requested === 'string' ? spelled(requested) : '';
  const found = apps.filter((app) => app.dir === wanted);
  if (found.length > 0) return found;
  const near = nearestName(wanted, dirs) ?? dirs[0] ?? '<app>';
  return {
    code: 'X_CLI_BAD_FLAG',
    cause:
      wanted === ''
        ? `--app needs a gated app (${dirs.join(', ')})`
        : `--app names ${wanted}, which is not a gated app (${dirs.join(', ')})`,
    fix: `bun run scripts/reference-app-gate.ts --app ${renderFixShellArg(near, '<app>')}`,
  };
};
