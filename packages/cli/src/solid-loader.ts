// The JSX transform every island chunk is built with: `.tsx` → Solid's runtime factory. `Bun.build`
// walks its own module graph, so the `Bun.plugin` @ultimat3/render installs for the SERVER never
// reaches it — and an app's tsconfig says `jsx: "preserve"`, which makes the bundler fall back to
// the CLASSIC React factory and emit `React.createElement` into a chunk that imports no React.

import type { BunPlugin } from 'bun';

/**
 * `solid-js/h`'s default export is a classic factory — `h(type, props, ...children)` — and its
 * `dynamicProperty`/`insert` calls are what make the result genuinely reactive rather than inert
 * markup. The specifier stays BARE so `Bun.build` resolves it from the app being built: an island
 * importing `createSignal` has to reach the same reactive graph this factory writes to, and two
 * copies of `solid-js` in one chunk is a signal that updates nothing.
 */
const JSX_FACTORY = '__xh';

/**
 * `h.Fragment` is a property of that same default export — Solid's children passthrough — so a
 * fragment costs no second import binding. `Bun.Transpiler` accepts a dotted `jsxFragmentFactory`
 * and emits `__xh(__xh.Fragment, …)`.
 */
const JSX_FRAGMENT = `${JSX_FACTORY}.Fragment`;

/** No newline: the prelude shares line 1 with the file's own first line, so stack traces still point at it. */
const JSX_PRELUDE = `import ${JSX_FACTORY} from 'solid-js/h';`;

/**
 * `jsx: 'react'`, never `'react-jsx'` / `'automatic'` / `'react-jsxdev'`: `Bun.Transpiler` ignores
 * every automatic form and ignores `jsxImportSource` entirely, so the classic factory pair is the
 * only setting that takes effect. `Bun.build`'s own `jsx:` option is not a substitute either —
 * measured on Bun 1.4.0, `runtime: 'classic'` emits the factory NAME and imports nothing (a free
 * variable in the chunk), and `runtime: 'automatic'` is ignored exactly as the transpiler ignores
 * it. A plugin that injects the import is the one shape that produces a chunk which can run.
 */
const transpiler = new Bun.Transpiler({
  loader: 'tsx',
  tsconfig: {
    compilerOptions: {
      jsx: 'react',
      jsxFactory: JSX_FACTORY,
      jsxFragmentFactory: JSX_FRAGMENT,
    },
  } as never,
});

/**
 * `.tsx` source → JS calling Solid's factory. Exported so the transform is testable as a pure
 * function: the plugin below is the four lines of glue that hand it a file.
 */
export function transformIslandTsx(source: string): string {
  return JSX_PRELUDE + transpiler.transformSync(source);
}

/**
 * The plugin `island-bundle.ts` hands `Bun.build`. It carries no state, so one frozen descriptor
 * serves every concurrent island build — `Bun.build` calls `setup` once per build with that
 * build's own builder.
 *
 * The filter is `.tsx` alone, matching the loader `@ultimat3/render` installs: a module ships JSX
 * if and only if its name says so, and a second accepted extension is a second rule.
 */
export const solidJsxPlugin: BunPlugin = {
  name: 'ultimate-island-solid',
  setup(build): void {
    build.onLoad({ filter: /\.tsx$/ }, async ({ path }) => ({
      contents: transformIslandTsx(await Bun.file(path).text()),
      loader: 'js',
    }));
  },
};
