// `x g app <name>` and `x g package <name>`: one more workspace in a scaffolded monorepo. Nothing
// outside the new directory changes: the root `workspaces` globs (`apps/*`, `packages/*`) admit it
// and the root tsconfig's one alias (`@<app>/*` → `packages/*/src`, then `apps/*`) reaches it.

import type { GeneratedFile, NameSet } from './naming';
import { packageShapeFiles, workspacePackageJson } from './scaffold-package-shape';

const appTsconfig = `{
  "extends": "../../tsconfig.json",
  "include": ["**/*.ts", "**/*.tsx", "../../types/scss.d.ts"]
}
`;

/**
 * No `dependencies`: an app declares a package as it first imports one (`package-shape`'s
 * `X_WORKSPACE_DEP_UNDECLARED`), and a fresh app imports nothing. `exports` is apps/admin's, so a
 * sibling's `import type` of a module here resolves the same way.
 */
const appPackageJson = (app: NameSet, name: string): string => `{
  "name": "@${app.kebab}/${name}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./*.ts",
    "./*.tsx": "./*.tsx"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  }
}
`;

/** `apps/<name>/`: scanned by the one boot like `apps/web`, served by the same image. */
export const workspaceAppFiles = (app: NameSet, name: string): readonly GeneratedFile[] => [
  { path: `apps/${name}/package.json`, contents: appPackageJson(app, name) },
  { path: `apps/${name}/tsconfig.json`, contents: appTsconfig },
];

const packageIndex = (
  app: NameSet,
  name: string,
): string => `// @${app.kebab}/${name}: code every app of this repo may share. Named exports only; it imports
// \`@ultimat3/*\` and sibling packages, never an app (the \`boundaries\` step,
// X_BOUNDARY_PACKAGE_TO_APP).

/** This package's import specifier, for a caller that has to name it in a message. */
export const PACKAGE_NAME = '@${app.kebab}/${name}';
`;

const packageTest = (
  app: NameSet,
): string => `// Pins the package's place in the repo: it is installed under the app's own scope, so a
// sibling imports it as \`@${app.kebab}/<name>\` and never by a relative path.

import { expect } from 'bun:test';
import { unitTest } from '@ultimat3/testing';
import { PACKAGE_NAME } from './index';

unitTest('the package is named into the app scope', () => {
  expect(PACKAGE_NAME.startsWith('@${app.kebab}/')).toBe(true);
});
`;

/** `packages/<name>/`: the root alias `@<app>/*` → `./packages/*\/src` already reaches it. */
export const workspacePackageFiles = (
  app: NameSet,
  name: string,
  description = 'Code shared by every app in this repository',
): readonly GeneratedFile[] => [
  { path: `packages/${name}/package.json`, contents: workspacePackageJson(app, name, description) },
  ...packageShapeFiles(app, name, description),
  { path: `packages/${name}/src/index.ts`, contents: packageIndex(app, name) },
  { path: `packages/${name}/src/index.test.ts`, contents: packageTest(app) },
];
