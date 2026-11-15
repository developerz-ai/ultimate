// `x upgrade codemods`: this CLI's codemods whose version lies after `--from`, up to `--to` (its own
// version by default), over the app. A hop runs it as the CLI it just installed, so the codemods
// are the target release's; by hand it carries an app whose hop ran under a CLI with none.

import { requireAppRoot } from './app-root';
import { CODEMODS } from './codemods';
import { runCodemods } from './codemods/engine';
import { fsCodemodApp } from './codemods/engine-fs';
import type { CommandContext } from './command';
import { ok } from './command';
import { BadFlagError } from './errors';
import { msg } from './messages';
import type { CommandResult, JsonValue } from './output';
import { flagBool, flagString } from './parse';
import { cliVersion } from './registry';
import { manifestSnapshot, reinstallIfMoved } from './upgrade-gate-codemods-install';
import { releaseOf } from './upgrade-plan';
import { codemodCounts, codemodLines } from './upgrade-report-codemods';

const FIX =
  'x upgrade codemods --from 31.20.0 --dry-run --json   # --from: the version the app came from, its old @ultimat3/cli pin';

const release = (ctx: CommandContext, flag: 'from' | 'to'): string | undefined => {
  const value = flagString(ctx.args, flag);
  if (value === undefined || releaseOf(value) !== undefined) return value;
  throw new BadFlagError({
    flag,
    command: 'upgrade codemods',
    reason: `"${value}" is not an exact release, major.minor.patch`,
    fix: FIX,
  });
};

export async function runUpgradeCodemods(ctx: CommandContext): Promise<CommandResult> {
  const root = requireAppRoot('upgrade codemods', ctx.cwd).dir;
  const from = release(ctx, 'from');
  if (from === undefined) {
    throw new BadFlagError({
      flag: 'from',
      command: 'upgrade codemods',
      reason:
        'names no release, and the codemods to run are the ones after the version the app came from',
      fix: FIX,
    });
  }
  const to = release(ctx, 'to') ?? cliVersion();
  const dryRun = flagBool(ctx.args, 'dry-run');
  const before = await manifestSnapshot(root);
  const ran = await runCodemods({
    app: fsCodemodApp(root),
    codemods: CODEMODS,
    from,
    to,
    dryRun,
  });
  // A codemod that moved a package.json owes the install, by hand as on a hop.
  const report =
    !dryRun && (await reinstallIfMoved({ runner: ctx.runner, root, to, before }))
      ? { ...ran, reinstalled: true as const }
      : ran;
  const counts = codemodCounts(report);
  return ok(
    'upgrade',
    msg(dryRun ? 'cli.upgrade.codemods.dryRun' : 'cli.upgrade.codemods.done', {
      from,
      to,
      ...counts,
    }),
    { data: { codemods: report as unknown as JsonValue }, lines: codemodLines(report) },
  );
}
