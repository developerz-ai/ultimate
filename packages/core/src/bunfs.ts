// Whether a directory is inside a `bun build --compile` executable's virtual filesystem. One answer
// for every platform, because Bun spells its root two ways: `/$bunfs/` on POSIX and `B:\~BUN\`
// (public form `B:/~BUN/`) on Windows — `BASE_PATH` / `BASE_PUBLIC_PATH` in Bun's
// `StandaloneModuleGraph`, as of Bun 1.4.2. An entry that tested only the first resolved its app root
// INSIDE the bundle on Windows, where no source exists, and every registry booted empty.

/** Each prefix is followed by a separator or nothing, so `/$bunfsx` or `B:\~BUNDLE` never match. */
const COMPILED_ROOT = /^(?:\/\$bunfs|[Bb]:[\\/]~BUN)(?:[\\/]|$)/;

/**
 * `true` when `dir` — normally `import.meta.dir` — is a path inside a compiled executable. Such a
 * path holds the entry's bundled imports and nothing else, so an app reads its root from the
 * directory it is started in instead.
 */
export function isCompiledBundle(dir: string): boolean {
  return COMPILED_ROOT.test(dir);
}
