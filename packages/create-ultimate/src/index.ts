// The whole package: turn `create-ultimate <name> [flags]` into `x new <name> [flags]`. No
// templates, no prompts, no second code path — this exists only so `bunx create-ultimate` works
// before @ultimat3/cli is installed.

import { dispatch } from '@ultimat3/cli';

export interface CreateAppOptions {
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly write: (line: string) => void;
}

export async function createApp(options: CreateAppOptions): Promise<number> {
  return dispatch({
    argv: ['new', ...options.argv],
    cwd: options.cwd,
    env: Bun.env,
    bunVersion: Bun.version,
    write: options.write,
  });
}
