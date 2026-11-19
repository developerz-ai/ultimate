#!/usr/bin/env bun
// `bun run typecheck`: `tsc -b` with its measured memory reserved in the machine ledger and this
// checkout's one-compiler lock held. Agents share one checkout, and two unserialised `tsc -b` runs
// write the same `.tsbuildinfo` and `dist/` and report errors that belong to neither.
//
//   bun run typecheck [<tsc -b flag>…]

import { withCheckoutLock, withHeavy } from '../packages/cli/src/heavy';
import { TYPECHECK_BUILD_PEAK_MB } from '../packages/cli/src/heavy-weights';
import { handOff } from '../packages/cli/src/local-cli-handoff';
import { localBin } from './lib/local-bin';
import { repoRoot } from './lib/run';

/** A full `tsc -b` from cold is minutes; a run past this has hung. */
const TSC_TIMEOUT_MS = 30 * 60_000;

/** The compiler's command line; what the caller passed goes last, as `tsc -b` once took it. */
export const typecheckArgv = (tsc: string, passed: readonly string[]): readonly string[] => [
  tsc,
  '-b',
  '--pretty',
  ...passed,
];

if (import.meta.main) {
  const root = repoRoot();
  const env = Bun.env;
  process.exitCode = await withHeavy(
    { label: 'typecheck', cwd: root, env, unitMb: TYPECHECK_BUILD_PEAK_MB },
    (held) =>
      withCheckoutLock({ name: 'typecheck', root, env }, held, (child) =>
        handOff(
          typecheckArgv(localBin(root, 'tsc'), Bun.argv.slice(2)),
          { ...env, ...child.env },
          {
            spawn: (command, childProcessEnv) =>
              Bun.spawn([...command], {
                cwd: root,
                env: childProcessEnv,
                stdio: ['inherit', 'inherit', 'inherit', ...child.fds],
                timeout: TSC_TIMEOUT_MS,
              }),
          },
        ),
      ),
  );
}
