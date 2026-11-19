// After a hop's codemods: the merge drivers its `.gitattributes` names, installed in this clone as
// `bun run setup` would, so an upgrade leaves no `X_MERGE_DRIVER_UNSET` for a person to act on.

// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import type { Runner } from './exec';
import { LOCAL_CLI_BIN } from './local-cli';
import { driverUnset } from './merge-driver-config';

/**
 * Through the installed CLI, which the hop just installed and which has the subcommand. True when
 * it ran and succeeded; a failure is not thrown, because `x doctor` reports the same unset driver
 * as a warning with its fix, beside the hop's verdict.
 */
export async function installMergeDrivers(runner: Runner, root: string): Promise<boolean> {
  if (!(await driverUnset(root, runner))) return false;
  const command = [
    process.execPath,
    join(root, LOCAL_CLI_BIN),
    'merge-driver',
    'install',
    '--json',
  ];
  return (await runner(command, { cwd: root })).ok;
}
