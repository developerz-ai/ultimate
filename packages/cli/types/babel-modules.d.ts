// Types for the two Babel packages the island JSX transform calls. Neither ships declarations and
// no `@types/babel-preset-solid` exists — and `@ultimat3/cli` ships SOURCE, so an APP typechecks
// `solid-loader.ts` and a `@types/*` devDependency here would never reach it. Only the surface
// actually called is declared: a fuller copy of Babel's types is a second one to keep in step.

declare module '@babel/core' {
  export interface BabelTransformOptions {
    readonly filename?: string;
    readonly babelrc?: boolean;
    readonly configFile?: boolean;
    readonly parserOpts?: { readonly plugins?: readonly string[] };
    /** `[preset, options]` pairs. The preset itself is opaque here — it is never called. */
    readonly presets?: readonly (readonly [unknown, unknown])[];
  }
  export interface BabelFileResult {
    readonly code?: string | null;
  }
  export function transformAsync(
    source: string,
    options: BabelTransformOptions,
  ): Promise<BabelFileResult | null>;
}

declare module 'babel-preset-solid' {
  /** A Babel preset factory, handed straight to `presets:` and never invoked by this package. */
  const preset: unknown;
  // `export =`, not `export default`: the package really is CommonJS whose `module.exports` IS the
  // factory, and that is what `esModuleInterop` gives the default import. It also keeps this file
  // clear of `noDefaultExport`, which `biome.json` waives for `scss.d.ts` alone.
  export = preset;
}
