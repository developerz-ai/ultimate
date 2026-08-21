// The manifest, plus the three contract files `x verify`'s `package-shape` step requires of every
// `packages/*` dir — enforced on a generated app exactly like it is on this repo, so `x new` has
// to ship them itself rather than leave the app's very first gate run red. Every scaffolded
// workspace package calls both exports here exactly once.

import type { GeneratedFile, NameSet } from './naming';

const packageTsconfig = (includes: readonly string[]): string => `{
  "extends": "../../tsconfig.json",
  "include": [${includes.map((glob) => `"${glob}"`).join(', ')}]
}
`;

const packageReadme = (
  app: NameSet,
  name: string,
  description: string,
): string => `# @${app.kebab}/${name}

${description}. Part of the ${app.kebab} monorepo — see the root README for how it fits.
`;

const packageClaude = (
  app: NameSet,
  name: string,
  description: string,
): string => `# @${app.kebab}/${name} — CLAUDE.md

${description}.

- Gate: \`x verify\` from the repo root — this package has no gate of its own.
- Exports: \`src/index.ts\`, named exports only, no \`export *\`.
- Imports: \`@ultimat3/*\` and this app's own \`@${app.kebab}/*\` packages, never a sibling app.
`;

/** `src/index.ts` is the package's own file, written separately since its contents differ
 * package to package — these three are identical in shape everywhere, except the tsconfig's
 * `include`: a package whose data sits outside `src/` (i18n's catalog JSON) names an extra glob
 * to reach it, so callers may override the default. */
export const packageShapeFiles = (
  app: NameSet,
  name: string,
  description: string,
  includes: readonly string[] = ['**/*.ts'],
): readonly GeneratedFile[] => [
  { path: `packages/${name}/README.md`, contents: packageReadme(app, name, description) },
  { path: `packages/${name}/CLAUDE.md`, contents: packageClaude(app, name, description) },
  { path: `packages/${name}/tsconfig.json`, contents: packageTsconfig(includes) },
];

/**
 * The manifest every scaffolded `packages/*` carries. Private, versionless-by-convention and
 * dependency-free: these packages only re-export a framework package's types. Three now DO name a
 * dependency and each writes its own manifest — `scaffold-i18n.ts`, `scaffold-mcp-package.ts` and
 * `scaffold-db-package.ts` (the last only under `--example`, which is the branch that emits the
 * import). Each says why at its own site. They write their own rather than taking a `dependencies`
 * parameter here because the edge is a fact about the SOURCE that template emits, and a parameter
 * would let a caller declare an edge its generated code does not have — which is the drift
 * `X_WORKSPACE_DEP_UNDECLARED` exists to catch, pointed the other way. Lives beside
 * `packageShapeFiles` because every caller of one calls the other.
 */
export const workspacePackageJson = (app: NameSet, name: string, description: string): string => `{
  "name": "@${app.kebab}/${name}",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "description": "${description}",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "typecheck": "tsc --noEmit -p ../../tsconfig.json"
  }
}
`;
