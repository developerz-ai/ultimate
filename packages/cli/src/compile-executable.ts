// A single-file executable whose graph carries the framework's own source: the `x` image
// (`docker/Dockerfile`, through `scripts/compile-x.ts`) and the boot e2e that proves it. One
// `Bun.build`, because the CLI's `bun build --compile` takes no plugin and this graph needs one.

import { serverTsxBuildPlugin } from '@ultimat3/render/server';
import { COMPILE_EXTERNALS } from './compile-externals';
import { ExecutableCompileFailedError } from './errors';

export interface CompileExecutableOptions {
  readonly entry: string;
  readonly outfile: string;
  /** `--define` pairs: each value is a JS expression, so a string arrives `JSON.stringify`-ed. */
  readonly define?: Readonly<Record<string, string>>;
  readonly minify?: boolean;
  readonly sourcemap?: boolean;
}

/**
 * The CLI registry reaches every admin screen and `@ultimat3/ui` component (`cmd-dev` → the dev
 * dashboard, `cmd-i18n` → the admin catalog): 92 `.tsx`, measured on 1.4.3. Compiled by Bun's own
 * transform each one imports `jsxDEV` from `solid-js/jsx-dev-runtime`, which exports no such name,
 * and Bun 1.4.3 refuses the build (issue #883) — through 1.4.2 it shipped a `React.createElement`
 * nobody defines. `serverTsxBuildPlugin` compiles them to the server factory, as the runtime
 * loader does for the same files off disk.
 */
export async function compileExecutable(options: CompileExecutableOptions): Promise<void> {
  const built = await Bun.build({
    entrypoints: [options.entry],
    compile: { outfile: options.outfile },
    minify: options.minify ?? false,
    sourcemap: options.sourcemap === true ? 'linked' : 'none',
    define: { ...options.define },
    external: [...COMPILE_EXTERNALS],
    plugins: [serverTsxBuildPlugin],
    throw: false,
  });
  if (!built.success) {
    throw new ExecutableCompileFailedError({
      entry: options.entry,
      outfile: options.outfile,
      logs: built.logs.map(String).join('\n'),
    });
  }
}
