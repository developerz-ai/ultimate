// One Solid runtime per island chunk: the app's. Every `solid-js` specifier in the island's graph
// — the entry's own `render` from `solid-js/web`, and the `solid-js/web` helpers the JSX
// transform writes into every `@ultimat3/ui` component — resolves to the copy the APP installed.
//
// Without this, `Bun.build` resolves each import from the importing file's REAL path. A package
// reached through a symlink (`file:` overrides, `bun link`, a workspace with its own install)
// resolves `solid-js` from its own `node_modules`, and the chunk ships two runtimes: measured on
// the scaffold's theme-toggle island under CI's own `file:` links, 62,463 B against 50,042 B with
// one (issue #490). Two copies are also two reactive graphs — a context created by one is never
// found by the other's `useContext` — so the dedupe is a correctness rule that happens to be the
// biggest single cut in the chunk, not a size trick.

// why: Bun ships no path API; `dirname` recovers the package directory from the manifest path
// `Bun.resolveSync` answers, and `join` puts an export target under it.
import { dirname, join } from 'node:path';
import type { BunPlugin } from 'bun';

const SOLID_PACKAGE = 'solid-js';

/** `solid-js` and every subpath of it — `solid-js/web`, `solid-js/store`, `solid-js/h`. */
export const SOLID_SPECIFIER = /^solid-js(?:\/.*)?$/;

/**
 * The conditions an island is built under, in the order they are tried: `browser` because the
 * chunk runs there, `import` because it is ESM, `default` as the map's own fallback. NOT
 * `development` — `island-bundle.ts` defines `process.env.NODE_ENV` as `"production"` for the
 * same reason, and solid nests `development` INSIDE `browser`, so walking without it is what
 * selects `dist/solid.js` over `dist/dev.js`.
 */
const BROWSER_CONDITIONS: readonly string[] = ['browser', 'import', 'default'];

/** `solid-js` → `.`, `solid-js/web` → `./web`: the key the package's `exports` map uses. */
export function solidSubpath(specifier: string): string {
  return specifier === SOLID_PACKAGE ? '.' : `.${specifier.slice(SOLID_PACKAGE.length)}`;
}

/**
 * The target one `exports` entry names under the conditions above — depth-first, in the map's
 * own key order, which is how Node and Bun read a conditions object. A string is a target; a
 * nested object is walked; a condition the island does not build under (`node`, `worker`,
 * `require`, `types`, `development`) is skipped. `undefined` when nothing matched, and the
 * caller then leaves the specifier to Bun's own resolver rather than guessing.
 */
export function conditionTarget(entry: unknown): string | undefined {
  if (typeof entry === 'string') return entry;
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return undefined;
  for (const [condition, nested] of Object.entries(entry)) {
    if (!BROWSER_CONDITIONS.includes(condition)) continue;
    const target = conditionTarget(nested);
    if (target !== undefined) return target;
  }
  return undefined;
}

export interface AppSolid {
  /** The installed package's directory — where every export target is joined onto. */
  readonly dir: string;
  /** Its `exports` map, verbatim. */
  readonly exports: unknown;
}

/**
 * The `solid-js` the app installed, found the way the app's own entry would find it: from the app
 * root upward. `null` when there is none — an app with no islands never gets here, and an island
 * importing solid where none is installed fails the build in Bun's own words either way.
 */
export async function resolveAppSolid(root: string): Promise<AppSolid | null> {
  let manifest: string;
  try {
    manifest = Bun.resolveSync(`${SOLID_PACKAGE}/package.json`, root);
  } catch {
    return null;
  }
  const parsed = (await Bun.file(manifest).json()) as { readonly exports?: unknown };
  return { dir: dirname(manifest), exports: parsed.exports };
}

/** Where `specifier` lands in the app's own copy, or `undefined` to leave it to Bun. */
export function appSolidPath(solid: AppSolid, specifier: string): string | undefined {
  const exports = solid.exports;
  if (exports === null || typeof exports !== 'object') return undefined;
  const entry = Object.hasOwn(exports, solidSubpath(specifier))
    ? (exports as Record<string, unknown>)[solidSubpath(specifier)]
    : undefined;
  const target = conditionTarget(entry);
  return target === undefined ? undefined : join(solid.dir, target);
}

/**
 * The plugin `island-bundle.ts` installs FIRST, so it sees every `solid-js` specifier before the
 * JSX and style plugins do. Resolved once per build and cached: the map is read from disk at
 * most one time however many modules import solid.
 */
export function solidDedupePlugin(root: string): BunPlugin {
  let app: Promise<AppSolid | null> | null = null;
  return {
    name: 'ultimate-solid-dedupe',
    setup(build): void {
      build.onResolve({ filter: SOLID_SPECIFIER }, async (args) => {
        app ??= resolveAppSolid(root);
        const solid = await app;
        if (solid === null) return undefined;
        const path = appSolidPath(solid, args.path);
        return path === undefined ? undefined : { path };
      });
    },
  };
}
