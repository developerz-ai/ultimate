// After codemods, the install they may owe: every `package.json` of the app read before and after,
// byte for byte — never a codemod's own report, which an installed CLI may under-state — and one
// `bun install` when any moved, so bun.lock and node_modules follow before anything reads them.

import { UltimateError } from '@ultimat3/core';
import type { Runner } from './exec';
import { execOutput } from './exec';

const MANIFESTS = new Bun.Glob('**/package.json');

/** Every `package.json` under the app root (none under `node_modules`), path to bytes. */
export async function manifestSnapshot(root: string): Promise<ReadonlyMap<string, string>> {
  const out = new Map<string, string>();
  for await (const path of MANIFESTS.scan({ cwd: root, dot: false })) {
    const posix = path.replaceAll('\\', '/');
    if (posix.split('/').includes('node_modules')) continue;
    out.set(posix, await Bun.file(`${root}/${posix}`).text());
  }
  return out;
}

const moved = (before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): boolean =>
  before.size !== after.size || [...after].some(([path, text]) => before.get(path) !== text);

/** `bun install` when a manifest moved since `before`; true when it ran. */
export async function reinstallIfMoved(input: {
  readonly runner: Runner;
  readonly root: string;
  readonly to: string;
  readonly before: ReadonlyMap<string, string>;
}): Promise<boolean> {
  if (!moved(input.before, await manifestSnapshot(input.root))) return false;
  const result = await input.runner([process.execPath, 'install'], { cwd: input.root });
  if (result.ok) return true;
  throw new UltimateError({
    code: 'X_UPGRADE_INSTALL_FAILED',
    cause: `bun install exited ${String(result.code)} after the ${input.to} codemods moved a package.json: ${execOutput(result).slice(-800) || 'no output'}`,
    fix: 'git diff -- "*package.json"   # the codemods\' edits; fix what the cause names, then: bun install && x upgrade --json',
  });
}
