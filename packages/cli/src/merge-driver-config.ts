// The two git merge drivers `.gitattributes` names, and whether this clone has them. Git keeps a
// driver's command in `.git/config`, which no clone inherits, so `x merge-driver install` (a step
// of `bun run setup`) writes it; an attribute naming an unknown driver is an ordinary text merge.

import type { Runner } from './exec';
import { quoteArg } from './shell-quote';

export const GENERATED_DRIVER = 'x-generated';
export const REGISTRY_DRIVER = 'x-registry';

/**
 * Through the installed binary, never `bunx x`: a clone with no install would fetch an unrelated
 * npm package named `x` and run it on the merge. With none, this is git's own text merge.
 */
export const registryDriverCommand = (prefix: string): string => {
  const bin = quoteArg(`${prefix}node_modules/.bin/x`);
  return `if [ -x ${bin} ]; then ${bin} merge-driver run %O %A %B %P; else git merge-file -L ours -L base -L theirs %A %O %B; fi`;
};

/** Every `git config` key and value, in the order they are written. */
export const driverConfig = (prefix: string): readonly (readonly [string, string])[] => [
  [`merge.${GENERATED_DRIVER}.name`, 'keep ours: x manifest rebuilds this file'],
  // `true` exits 0 and leaves our side in place: the file is a projection, rebuilt after the merge.
  [`merge.${GENERATED_DRIVER}.driver`, 'true'],
  [`merge.${REGISTRY_DRIVER}.name`, 'keep what both sides added to an x registry'],
  [`merge.${REGISTRY_DRIVER}.driver`, registryDriverCommand(prefix)],
];

/** `undefined` outside a git checkout. */
export async function gitPrefix(root: string, runner: Runner): Promise<string | undefined> {
  const found = await runner(['git', 'rev-parse', '--show-prefix'], { cwd: root });
  return found.ok ? found.stdout.trim() : undefined;
}

/** Whether `.gitattributes` names the driver and this clone does not define it. */
export async function driverUnset(root: string, runner: Runner): Promise<boolean> {
  const attributes = Bun.file(`${root}/.gitattributes`);
  if (!(await attributes.exists())) return false;
  if (!(await attributes.text()).includes(`merge=${REGISTRY_DRIVER}`)) return false;
  if ((await gitPrefix(root, runner)) === undefined) return false;
  const key = `merge.${REGISTRY_DRIVER}.driver`;
  return !(await runner(['git', 'config', '--get', key], { cwd: root })).ok;
}
