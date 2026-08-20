// The specifiers every `bun build --compile` in this repo must refuse to resolve. One list, because
// the flag is repeated at each compile site — `binaryArgs`, `docker/Dockerfile`, the boot e2e — and
// three copies of a resolver allowlist is three chances for one of them to be the stale one.

/**
 * `@babel/preset-typescript` is reached from `@babel/core`'s `.cts`-config loader and from nowhere
 * else. `config/files/module-types.js` `require`s it twice — once for the preset, once for its
 * `package.json` inside a `catch` — and both sit in `loadCtsDefault`, which only runs while Babel
 * loads a `.cts` CONFIG FILE. `solid-loader.ts` passes `babelrc: false, configFile: false`, so no
 * config file is ever loaded and neither line is reachable at run time. The bundler walks them
 * anyway, and that is the whole failure: Bun 1.3 (what CI pins and what `docker/Dockerfile` builds
 * on) refuses the build with `Could not resolve: "@babel/preset-typescript/package.json"`, while
 * Bun 1.4 bundles the unresolvable `require` as a runtime throw — so one tree compiled on a laptop
 * and did not in CI.
 *
 * Marking the dead specifier external rather than the two live ones: `serve.ts` calls
 * `buildIslands` on every boot, unconditionally, so a binary with `@babel/core` external is a
 * binary that dies at start with `Cannot find module '@babel/core' from '/$bunfs/root/app'` —
 * measured. And rather than installing `@babel/preset-typescript`: that is a real dependency, in
 * the lockfile and in every published tarball's resolution graph, bought to make one unreachable
 * line resolvable.
 *
 * A lazy `await import('@babel/core')` does not help and was measured too — Bun's bundler follows a
 * literal dynamic specifier into `--compile`, so the graph still reaches the same require.
 */
export const COMPILE_EXTERNALS: readonly string[] = ['@babel/preset-typescript'];

/**
 * `--external <specifier>` per entry, flattened into the argv shape every compile site splices in.
 * A function and not a frozen array so a caller cannot hold a reference it then mutates.
 */
export function externalArgs(): readonly string[] {
  return COMPILE_EXTERNALS.flatMap((specifier) => ['--external', specifier]);
}
