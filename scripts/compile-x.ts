#!/usr/bin/env bun

// Compile the `x` CLI to one self-contained binary — what `docker/Dockerfile`'s build stage runs.
// A script and not `bun build --compile`, because the CLI graph reaches the framework's `.tsx` and
// only `Bun.build` takes the plugin that compiles them (`packages/cli/src/compile-executable.ts`).
//
//   bun run scripts/compile-x.ts --outfile /out/app

import { compileExecutable } from '../packages/cli/src/compile-executable';
import { VERSION_DEFINE } from '../packages/core/src/version';
import { flagString, parseScriptArgs } from './lib/args';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/** The CLI's entry, the file `x` is. */
const X_ENTRY = 'packages/cli/src/bin.ts';

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const outfile = flagString(args, 'outfile');
  if (outfile === undefined) {
    report(
      {
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
      },
      args.json,
    );
  }
  const root = repoRoot();
  // A single-file executable carries no `package.json`: the define is the version `x --version`
  // answers (`docker/Dockerfile` says why it is not optional).
  const version = (
    (await Bun.file(`${root}/packages/core/package.json`).json()) as { version: string }
  ).version;
  await compileExecutable({
    entry: `${root}/${X_ENTRY}`,
    outfile,
    define: { [VERSION_DEFINE]: JSON.stringify(version) },
    minify: true,
    sourcemap: true,
  });
  report(
    { ok: true, script: 'compile-x', summary: `x ${version} compiled to ${outfile}` },
    args.json,
  );
}
