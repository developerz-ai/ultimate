// Which `tsc` invocation the `typecheck` step runs. `tsc -b` decides "up to date" by mtime, and Bun
// installs a package as HARDLINKS out of its cache, carrying the cache's old mtimes — so upgrading
// a dependency to a version already in the cache left every input older than the buildinfo, `-b`
// skipped the program and reported green while a cold CI went red (#450). `-p` with `incremental`
// re-reads every input and compares content hashes, so it cannot be fooled by a date.

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
