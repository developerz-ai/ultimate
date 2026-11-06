// The two halves both `x client` subcommands share: the compile, refused when `--only` keeps
// nothing, and the write of every file a generation produces.

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import { BadFlagError } from './errors';
import { compileOpenApi } from './openapi-compile';
import type { CompiledDocument } from './openapi-compile-ir';

/** Where every vendor client lives, app-root-relative. */
export const CLIENTS_DIR = 'apps/web/clients';

/** The compile, refused when `--only` kept nothing: an empty client is a typo, not a client. */
export function compileOrRefuse(
  document: unknown,
  source: string,
  only: readonly string[] | undefined,
  command: string,
): CompiledDocument {
  const compiled = compileOpenApi(document, { source, only });
  if (only !== undefined && compiled.operations.length === 0) {
    throw new BadFlagError({
      flag: 'only',
      command,
      reason: `no operation in ${source} carries a tag in ${only.join(',')}`,
      fix: 'x help client --json   # then rerun without --only, and pick tags from the operations it lists',
    });
  }
  return compiled;
}

/** Writes every file (`Bun.write` makes the directories); answers the app-root-relative paths written. */
export async function writeFiles(
  root: string,
  files: ReadonlyMap<string, string>,
): Promise<readonly string[]> {
  for (const [path, text] of files) {
    await Bun.write(join(root, path), text);
  }
  return [...files.keys()];
}
