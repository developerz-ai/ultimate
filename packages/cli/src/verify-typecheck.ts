// Which `tsc` invocation the `typecheck` step runs: `-p` with `incremental` for a root with no
// project references (every scaffolded app), `-b` for one that declares them — its only walker.
//
// `tsc -b` decides "up to date" by mtime, and Bun installs a package as HARDLINKS out of its cache,
// carrying the cache's old mtimes — so upgrading a dependency to a version already in the cache
// left every input older than the buildinfo, `-b` skipped the program and reported green while a
// cold CI went red (#450). `-p` with `incremental` re-reads every input and compares content
// hashes, so it cannot be fooled by a date. A root WITH references still runs `-b` and keeps
// that exposure: after a dependency upgrade there, start over with a clean build.

import type { Finding } from './output';
import { checkRootReferences } from './tsconfig-references';

/**
 * A package dir no reference can name. `checkRootReferences` answers `[]` when the root has no
 * `references` array at all and one finding for this probe when it has one, which is the one
 * question asked here — without a second JSONC parser beside the one that file owns.
 */
const PROBE = '\u0000x-verify-typecheck-probe';

/** True when the root tsconfig declares `references`: a build graph that only `-b` can walk. */
export const usesProjectReferences = async (root: string): Promise<boolean> =>
  (await checkRootReferences(root, [PROBE])).length > 0;

/**
 * The argv after `bunx`. A root with references keeps `-b` — the framework's 32 projects are only
 * reachable that way, and `tsc -b` rebuilds a project whose own sources moved. A root without them
 * (every scaffolded app) is ONE program, and `-p .` is the content-hashed check of it.
 */
export async function typecheckArgs(root: string, bin: string): Promise<readonly string[]> {
  const mode = (await usesProjectReferences(root)) ? ['-b'] : ['-p', '.'];
  return [bin, ...mode, '--pretty', 'false'];
}

/** `apps/web/a.ts(3,7): error TS2322: …`, the first line of `tsc --pretty false` that names a place. */
const FIRST_ERROR = /^(.+?)\((\d+),\d+\): error TS/m;

/**
 * The step's red finding. The errors are already printed under it, so the fix opens at the first of
 * them and re-runs the step: a raw `tsc` repeats the list outside the machine ledger and this
 * checkout's compiler lock.
 */
export function typecheckFinding(output: string): Omit<Finding, 'docs'> {
  const first = FIRST_ERROR.exec(output);
  return {
    code: 'X_TYPECHECK_FAILED',
    cause: 'the project does not typecheck',
    fix:
      first === null
        ? 'x verify --only typecheck --json   # its output carries what tsc printed'
        : `edit ${first[1]}:${first[2]} — and each other file(line) tsc listed under this finding, then: x verify --only typecheck`,
  };
}
