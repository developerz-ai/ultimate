// What the gate's `e2e` step does around the suite in an APP: when this machine has a browser, it
// runs the suite with the e2e preload and names the app root, and the PRELOAD spawns the app — so
// the app lives in the test process, where `deploy.newBuild()` can restart it. No browser, or not an
// app: the suite runs as before and its browser-backed cases skip — or refuse under
// `E2E_BROWSER_REQUIRED=1`.

import { findChrome } from '@ultimat3/scraping/cdp';
import { E2E_ROOT_ENV } from '@ultimat3/testing';
import type { ExecResult } from './exec';

/**
 * The preload `bun test` is handed, beside the app's own from `bunfig.toml` — `@ultimat3/testing`'s,
 * resolved from here to the absolute path the child process loads. A FUNCTION, resolved when a run
 * needs it: at module scope it ran on every import of the registry, and a compiled `x` binary —
 * whose `/$bunfs` holds no `node_modules` — died at boot resolving a file it never uses.
 */
export const e2ePreload = (): string =>
  Bun.resolveSync('@ultimat3/testing/e2e-preload', import.meta.dir);

/** The device zone every browser-backed app e2e run uses, never the runner's ambient zone. */
export const E2E_TIME_ZONE = 'America/Los_Angeles';

export interface E2eRun {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}

/** Add the app preload and its deterministic device zone after a browser was found. */
export function appE2eRun(input: {
  readonly root: string;
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
}): E2eRun {
  const [bun = 'bun', test = 'test', ...rest] = input.command;
  return {
    command: [bun, test, '--preload', e2ePreload(), ...rest],
    env: { ...input.env, [E2E_ROOT_ENV]: input.root, TZ: E2E_TIME_ZONE },
  };
}

/** Wrap one e2e `bun test` invocation: `run` receives the command and extra environment to use. */
export async function withE2eApp(
  input: {
    readonly root: string;
    readonly isApp: boolean;
    readonly command: readonly string[];
    readonly env: Readonly<Record<string, string | undefined>>;
  },
  run: (e2e: E2eRun) => Promise<ExecResult>,
): Promise<ExecResult> {
  const chrome = input.isApp ? await findChrome(Bun.env) : undefined;
  if (chrome === undefined) return run({ command: input.command, env: input.env });
  return run(appE2eRun(input));
}
