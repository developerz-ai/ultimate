// The whole package: `create-ultimate <name> [flags]` is `x new <name> [flags]` — no templates, no
// prompts, no second scaffolder — and `create-ultimate repro <bundle.json>` opens a bug's
// `x repro --bundle` file into a scratch app built by that same scaffolder (`repro.ts`).

import { dispatch, exitCodeFor, findingFrom, render } from '@ultimat3/cli';
import { openRepro } from './repro';

export interface CreateAppOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly write: (line: string) => void;
}

/** `repro` followed by a file is a bundle to open; `repro` alone stays an app named `repro`. */
const opensBundle = (argv: readonly string[]): boolean =>
  argv[0] === 'repro' && argv[1] !== undefined && !argv[1].startsWith('-');

async function openBundle(options: CreateAppOptions): Promise<number> {
  const json = options.argv.includes('--json') || options.argv.includes('-j');
  const result = await openRepro(options.argv, options.cwd).catch((error: unknown) => ({
    ok: false,
    command: 'repro',
    summary: findingFrom(error).cause,
    findings: [findingFrom(error)],
  }));
  options.write(render(result, json));
  return exitCodeFor(result);
}

export async function createApp(options: CreateAppOptions): Promise<number> {
  if (opensBundle(options.argv)) return openBundle(options);
  return dispatch({
    argv: ['new', ...options.argv],
    // What the caller actually typed, so every `fix:` `x new` would have written names a command
    // that runs HERE. `bunx`, not `npx`: this package is Bun-only and its `bin` needs a Bun.
    invocation: 'bunx create-ultimate',
    cwd: options.cwd,
    env: Bun.env,
    bunVersion: Bun.version,
    write: options.write,
  });
}
