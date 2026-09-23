// What the gate's `e2e` step does around the suite in an APP: when this machine has a browser, it
// runs the suite with the e2e preload and names the app root, and the PRELOAD spawns the app — so
// the app lives in the test process, where `deploy.newBuild()` can restart it. No browser, or not an
// app: the suite runs as before and its browser-backed cases skip — or refuse under
// `E2E_BROWSER_REQUIRED=1`.

// why: Bun exposes no path API — the preload is addressed by an absolute path the child resolves.
import { join } from 'node:path';
import { findChrome } from './cdp-launch';
import { E2E_ROOT_ENV } from './e2e-browser-handle';
import type { ExecResult } from './exec';

/** The preload `bun test` is handed, beside the app's own from `bunfig.toml`. */
export const E2E_PRELOAD = join(import.meta.dir, 'e2e-preload.ts');

export interface E2eRun {
  readonly command: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
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
  const [bun = 'bun', test = 'test', ...rest] = input.command;
  return run({
    command: [bun, test, '--preload', E2E_PRELOAD, ...rest],
    env: { ...input.env, [E2E_ROOT_ENV]: input.root },
  });
}
