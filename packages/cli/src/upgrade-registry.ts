// What npm publishes, as `bun pm view` answers it: every version of the CLI, and the Bun floor of one.
// Through the app's own registry config, because `bun pm view` runs from the app root. Any failure
// here is `X_UPGRADE_REGISTRY_UNREACHABLE`, and it can only fire before the hop has written anything.

import { UltimateError } from '@ultimat3/core';
import { t } from '@ultimat3/schema';
import type { ExecResult, Runner } from './exec';
import { execOutput } from './exec';

const PACKAGE = '@ultimat3/cli';
const VERSIONS = t.array(t.string);
const ENGINES = t.object({ bun: t.optional(t.string) });

const unreachable = (result: ExecResult): UltimateError =>
  new UltimateError({
    code: 'X_UPGRADE_REGISTRY_UNREACHABLE',
    cause: `${result.command.slice(1).join(' ')} exited ${String(result.code)}: ${execOutput(result).slice(-500) || 'no output'}`,
    fix: 'bun pm view @ultimat3/cli version   # once this answers, re-run: x upgrade --json',
  });

/** A child's stdout as JSON, or undefined: a foreign answer that will not parse is not a crash. */
export const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};

const view = async (runner: Runner, cwd: string, args: readonly string[]): Promise<ExecResult> => {
  const result = await runner([process.execPath, 'pm', 'view', ...args, '--json'], { cwd });
  if (!result.ok) throw unreachable(result);
  return result;
};

/** Every version npm publishes for the CLI, as npm orders them. */
export async function publishedVersions(runner: Runner, cwd: string): Promise<readonly string[]> {
  const result = await view(runner, cwd, [PACKAGE, 'versions']);
  const parsed = VERSIONS.safeParse(parseJson(result.stdout));
  if (parsed.issues !== undefined) throw unreachable(result);
  return parsed.value as readonly string[];
}

/** `engines.bun` of one release; undefined when that release declares none. */
export async function releaseBunRange(
  runner: Runner,
  cwd: string,
  version: string,
): Promise<string | undefined> {
  const result = await view(runner, cwd, [`${PACKAGE}@${version}`, 'engines']);
  const parsed = ENGINES.safeParse(parseJson(result.stdout));
  return parsed.issues === undefined ? (parsed.value as { readonly bun?: string }).bun : undefined;
}
