// Where a repo's shipped source lives, in both shapes the gate runs against: a package monorepo
// and an app. One list for every step that walks source, because two steps scanning different sets
// means a finding one of them can never see.

export const SOURCE_GLOBS = [
  'packages/*/src/**/*.{ts,tsx}',
  // Three packages carry an `e2e` directory beside `src`. It is shipped source by every rule that
  // matters here — a 900-line file or an unrunnable `fix:` in one was invisible to `filesize` and
  // `errors` alike, and `scripts/boundaries.ts` walked past it for the same reason.
  'packages/*/e2e/**/*.{ts,tsx}',
  'scripts/**/*.{ts,tsx}',
  'site/**/*.{ts,tsx}',
  'app/**/*.{ts,tsx}',
  'api/**/*.{ts,tsx}',
  'shared/**/*.{ts,tsx}',
  'apps/*/{app,site,api,shared}/**/*.{ts,tsx}',
] as const;

/**
 * A nested example app under `examples/` is not scanned — it runs this same gate from its own
 * root. `dist/` is build output: the sources that produced it are already in the set.
 */
export const isVendored = (path: string): boolean =>
  path.includes('node_modules') || path.includes('/dist/') || path.startsWith('dist/');

/** Emitted declarations, not authored source — a rule about authored code cannot apply to them. */
export const isGenerated = (path: string): boolean => path.endsWith('.d.ts');

/** Every opt-in suffix (`*.{contract,live,job,eval,e2e}.test.ts`) still ends `.test.ts`. */
export const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path);

/** Every source file under `root`, repo-relative and deduplicated across the globs. */
export async function* eachSourceFile(root: string): AsyncGenerator<string> {
  const seen = new Set<string>();
  for (const pattern of SOURCE_GLOBS) {
    for await (const path of new Bun.Glob(pattern).scan({ cwd: root, absolute: false })) {
      if (isVendored(path) || seen.has(path)) continue;
      seen.add(path);
      yield path;
    }
  }
}
