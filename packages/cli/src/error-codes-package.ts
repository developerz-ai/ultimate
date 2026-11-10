// The X_* codes of the `package-shape` and `filesize` steps — what a workspace owes the repo it lives
// in — split out of `error-codes.ts` at its 500-line ceiling, as `error-codes-shot.ts` was. That
// file folds these into the CLI's one owned union and registers them in its one call.

/** Codes the workspace-shape rules declare and own. */
export const CLI_PACKAGE_ERROR_CODES = [
  'X_FILE_TOO_LONG',
  'X_PACKAGE_SHAPE',
  // The build graph's own membership rule. `tsc -b` compiles referenced projects and nothing
  // else, so a workspace no root reference names is one the `typecheck` step passes over without
  // reading — the hole that let `scripts/` hold seven type errors under a green gate.
  'X_PACKAGE_UNREFERENCED',
  'X_RELEASE_VERSION_SKEW',
  'X_WORKSPACE_DEP_UNDECLARED',
  // Two module instances of a registry-holding package inside ONE app's `node_modules`. Its own
  // code and not the registry's (`X_CATALOG_UNREGISTERED`, `X_PERMISSION_UNKNOWN`): those carry a
  // source-level fix, and an agent following it here edits a file that is already right — the
  // repair is an install, and only `duplicate-packages.ts` can see that.
  'X_PACKAGE_DUPLICATED',
  'X_PACKAGE_TEST_ONLY_SHIPPED',
  // A registry import only a SIBLING declares: hoisting resolves it until a clean install does not.
  'X_WORKSPACE_EXTERNAL_DEP_UNDECLARED',
] as const;

export type CliPackageErrorCode = (typeof CLI_PACKAGE_ERROR_CODES)[number];

/** Their titles, typed over the list above so a code without one is a build error. */
export const CLI_PACKAGE_ERROR_TITLES: Readonly<Record<CliPackageErrorCode, string>> = {
  X_FILE_TOO_LONG: 'a source file is over 500 lines',
  X_PACKAGE_SHAPE: 'a workspace package is missing a contract file',
  X_PACKAGE_UNREFERENCED: 'a published workspace is not in the root tsconfig build graph',
  X_RELEASE_VERSION_SKEW: 'a workspace is not at the lockstep version',
  X_WORKSPACE_DEP_UNDECLARED: 'a workspace imports another workspace it does not declare',
  X_PACKAGE_DUPLICATED: 'two copies of one registry-holding framework package are installed',
  X_PACKAGE_TEST_ONLY_SHIPPED: 'a test-only module ships in the tarball',
  X_WORKSPACE_EXTERNAL_DEP_UNDECLARED:
    'a workspace imports a registry package that neither it nor the app root declares',
};
