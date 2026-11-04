#!/usr/bin/env bun

// Compile the `x` CLI to one self-contained binary — what `docker/Dockerfile`'s build stage runs.
// A script and not `bun build --compile`, because the CLI graph reaches the framework's `.tsx` and
// only `Bun.build` takes the plugin that compiles them (`packages/cli/src/compile-executable.ts`).
//
//   bun run scripts/compile-x.ts --outfile /out/app

import { compileExecutable } from '../packages/cli/src/compile-executable';
import { VERSION_DEFINE } from '../packages/core/src/version';
import { flagString, parseScriptArgs } from './lib/args';
import type { ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/** The CLI's entry, the file `x` is. */
const X_ENTRY = 'packages/cli/src/bin.ts';

/** What one compile is asked for: where the binary goes, and the checkout it is built from. */
export interface CompileXRequest {
  /** Where the binary is written; `undefined` is the refusal. */
  readonly outfile: string | undefined;
  /** The checkout the CLI graph is read from. */
  readonly root: string;
}

/**
 * The whole command as a value: the refusal when there is no `--outfile`, and the compile with its
 * summary when there is.
 *
 * A function and not a `report()` call, so a test can drive the refusal. The block this moved out
 * of ran only as a process, so every line of it counted as uncovered — a command nothing could
 * exercise was a command nothing had proved.
 */
export async function compileX(request: CompileXRequest): Promise<ScriptResult> {
  const outfile = request.outfile;
  if (outfile === undefined) {
    return {
      ok: false,
      script: 'compile-x',
      summary: '--outfile is required',
      findings: [
        {
          code: 'X_CONFIG_INVALID',
          cause: 'compile-x writes one binary and was not told where',
          fix: 'bun run scripts/compile-x.ts --outfile /out/app',
        },
      ],
    };
  }
  // A single-file executable carries no `package.json`: the define is the version `x --version`
  // answers (`docker/Dockerfile` says why it is not optional).
  const version = (
    (await Bun.file(`${request.root}/packages/core/package.json`).json()) as { version: string }
  ).version;
  await compileExecutable({
    entry: `${request.root}/${X_ENTRY}`,
    outfile,
    define: { [VERSION_DEFINE]: JSON.stringify(version) },
    minify: true,
    sourcemap: true,
  });
  return { ok: true, script: 'compile-x', summary: `x ${version} compiled to ${outfile}` };
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(await compileX({ outfile: flagString(args, 'outfile'), root: repoRoot() }), args.json);
}
