// The ONE policy for which paths are never a test the gate runs here, projected twice: the path
// predicate `discoverTests` filters by and the `--path-ignore-patterns` the serial steps pass to
// `bun test`. A leaf, so `test-select.ts` and `verify-tests.ts` (which import each other) share it.

/** Build output and installed packages: never a test, at ANY depth — a workspace's `dist/` too. */
const IGNORED_ANYWHERE = ['dist', 'node_modules'] as const;

/**
 * Nested projects with their own gate (`examples/`, `dummy/`, run by
 * `scripts/reference-app-gate.ts`) and the root `build/` — skipped AT THE ROOT only. Matched at any
 * depth they swallowed an app's own slice: `x g resource build` lost 14 of its 16 test files and
 * `x g resource example` its `examples/` page tests, from `x test` and the gate alike.
 */
const IGNORED_AT_ROOT = ['build', 'examples', 'dummy'] as const;

/** Whether a root-relative POSIX path is excluded from every test selection. */
export const isIgnoredTestPath = (path: string): boolean =>
  IGNORED_ANYWHERE.some((dir) => `/${path}`.includes(`/${dir}/`)) ||
  IGNORED_AT_ROOT.some((dir) => path.startsWith(`${dir}/`));

/** The same policy as `bun test --path-ignore-patterns` globs, relative to the run's root. */
export const IGNORED_TEST_PATTERNS: readonly string[] = [
  ...IGNORED_ANYWHERE.map((dir) => `**/${dir}/**`),
  ...IGNORED_AT_ROOT.map((dir) => `${dir}/**`),
];
