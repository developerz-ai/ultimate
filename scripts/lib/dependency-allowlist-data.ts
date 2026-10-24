// The checked-in allowlist of external workspace dependencies, keyed by manifest, field and name.
// Data only; every row says why the repository accepts the dependency.
//
// The key is '<manifest path>#<field>#<dependency name>': one row per declaration, so a new
// external dependency cannot be introduced by copying another manifest's row.
//
//   bun run scripts/dependency-allowlist.ts --json

/** Where the table lives, so a stale-row finding can name the file to edit. */
export const DEPENDENCY_ALLOWLIST_FILE = 'scripts/lib/dependency-allowlist-data.ts';

export const DEPENDENCY_ALLOWLIST: Readonly<Record<string, { readonly reason: string }>> = {
  'dummy/social-media-clone/package.json#dependencies#solid-js': {
    reason: 'The SolidJS runtime the UI and app surfaces render with.',
  },
  'dummy/social-media-clone/package.json#devDependencies#@biomejs/biome': {
    reason: 'The repository linter and formatter.',
  },
  'dummy/social-media-clone/package.json#devDependencies#@electric-sql/pglite': {
    reason: 'The embedded Postgres driver used by local and test runs.',
  },
  'dummy/social-media-clone/package.json#devDependencies#@types/bun': {
    reason: 'Bun runtime type declarations for TypeScript.',
  },
  'dummy/social-media-clone/package.json#devDependencies#typescript': {
    reason: 'The repository compiler.',
  },
  'examples/dummy/apps/web/package.json#dependencies#solid-js': {
    reason: 'The SolidJS runtime the UI and app surfaces render with.',
  },
  'examples/dummy/package.json#devDependencies#typescript': { reason: 'The repository compiler.' },
  'examples/dummy/packages/ui/package.json#dependencies#solid-js': {
    reason: 'The SolidJS runtime the UI and app surfaces render with.',
  },
  'package.json#devDependencies#@biomejs/biome': { reason: 'The repository linter and formatter.' },
  'package.json#devDependencies#@electric-sql/pglite': {
    reason: 'The embedded Postgres driver used by local and test runs.',
  },
  'package.json#devDependencies#@types/bun': {
    reason: 'Bun runtime type declarations for TypeScript.',
  },
  'package.json#devDependencies#lefthook': { reason: 'The repository git-hook runner.' },
  'package.json#devDependencies#solid-js': {
    reason: 'The SolidJS runtime the UI and app surfaces render with.',
  },
  'package.json#devDependencies#typescript': { reason: 'The repository compiler.' },
  'packages/cli/package.json#dependencies#@babel/core': {
    reason: 'Babel transforms JSX for the CLI island compiler.',
  },
  'packages/cli/package.json#dependencies#babel-preset-solid': {
    reason: 'The CLI island compiler compiles Solid JSX.',
  },
  'packages/realtime/package.json#dependencies#nats': {
    reason: 'The realtime NATS transport is an optional production driver.',
  },
  'packages/render/package.json#dependencies#sass': {
    reason: 'The render package compiles its own Sass design tokens.',
  },
};
