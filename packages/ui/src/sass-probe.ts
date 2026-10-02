// TEST-ONLY. Compiles a stylesheet with the compiler an app's build uses, so a test can read what
// Sass EMITS — a media query, a `clamp()`, the class list a mixin generates, an `@error` — instead
// of the source it was written as. Never exported from `index.ts`, like `jsx-probe.ts`.

/** The two members of Sass's API this file calls; the package itself is not a dependency of `ui`. */
interface SassApi {
  compileString(source: string, options: { readonly url: URL }): { readonly css: string };
}

let loading: Promise<SassApi> | undefined;

/**
 * `sass` is `@ultimat3/render`'s dependency — the package that compiles an app's sheets — and `ui`
 * may not import `render` (tier 4, both). Resolved FROM render's directory, so a test compiles with
 * the one compiler at the one version the lockfile pins and `ui` declares no second copy. Only a
 * specifier is read from render; no module of it loads. Lazy, so importing this file has no effect.
 */
function sassCompiler(): Promise<SassApi> {
  loading ??= import(
    Bun.resolveSync('sass', new URL('../../render', import.meta.url).pathname)
  ) as Promise<SassApi>;
  return loading;
}

/** Compile `source` as though it were the file at `path`, so its relative `@use`s resolve. */
export async function compileScss(source: string, path: string): Promise<string> {
  const sass = await sassCompiler();
  return sass.compileString(source, { url: new URL(`file://${path}`) }).css;
}

/** Compile a stylesheet that exists on disk. */
export async function compileScssFile(path: string): Promise<string> {
  return compileScss(await Bun.file(path).text(), path);
}

/**
 * The `@error` text Sass refused `source` with, or `undefined` when it compiled. A refusal that is
 * not Sass's own — the compiler failing to load — is rethrown: it is not an answer about `source`.
 */
export async function scssRefusal(source: string, path: string): Promise<string | undefined> {
  try {
    await compileScss(source, path);
  } catch (error) {
    if (typeof error === 'object' && error !== null && 'sassMessage' in error) {
      return String(error.sassMessage);
    }
    throw error;
  }
  return undefined;
}

/** Every class a compiled stylesheet declares. */
export function declaredClasses(css: string): ReadonlySet<string> {
  return new Set([...css.matchAll(/\.([A-Za-z][\w-]*)/g)].map((match) => match[1] as string));
}
