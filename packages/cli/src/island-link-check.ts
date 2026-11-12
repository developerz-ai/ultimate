// The post-build smoke #1075 asked for: every name an island output imports from another output
// of the bundle is a name that output exports. Groups come out of a cache, a store or a fresh
// build, and the vendor and page runtime are built apart — a binding that names nothing would
// fail in the browser as a `SyntaxError` on a blank island; here it fails the build, by file.

// why: Bun ships no path API; `basename` of a relative specifier.
import { posix } from 'node:path';
import { IslandBuildFailedError } from './errors';

/** One output as the check reads it: where it is served and what it is. */
export interface LinkedAsset {
  readonly url: string;
  readonly code: string;
  /** The island source a refusal names — the entry's own, or a shared chunk's first importer. */
  readonly file?: string | undefined;
}

/** A static `import{a as b,c}from"./x.js"` as Bun's minifier writes one. */
const NAMED_IMPORT = /import\s*\{([^}]*)\}\s*from\s*"(\.\/[^"]+)"/g;

/** `a as b` → `a`; `default as b` → `default`; a quoted name keeps its spelling. */
const importedName = (binding: string): string => {
  const [name = ''] = binding.trim().split(/\s+as\s+/);
  return name.startsWith('"') ? (JSON.parse(name) as string) : name;
};

export interface UnboundImport {
  readonly importer: string;
  readonly file: string | undefined;
  readonly target: string;
  readonly name: string;
}

/** Every imported name no sibling output exports, in the order found; empty when all bind. */
export function unboundImports(assets: readonly LinkedAsset[]): readonly UnboundImport[] {
  const byName = new Map(assets.map((one) => [posix.basename(one.url), one]));
  const exportsOf = new Map<string, ReadonlySet<string>>();
  const transpiler = new Bun.Transpiler({ loader: 'js' });
  const exported = (asset: LinkedAsset): ReadonlySet<string> => {
    let known = exportsOf.get(asset.url);
    if (known === undefined) {
      known = new Set(transpiler.scan(asset.code).exports);
      exportsOf.set(asset.url, known);
    }
    return known;
  };
  const unbound: UnboundImport[] = [];
  for (const asset of assets) {
    for (const match of asset.code.matchAll(NAMED_IMPORT)) {
      const target = byName.get(posix.basename(match[2] ?? ''));
      // A specifier naming no output of the bundle is not this check's: nothing it links to.
      if (target === undefined) continue;
      const names = exported(target);
      for (const binding of (match[1] ?? '').split(',')) {
        const name = importedName(binding);
        if (name !== '' && !names.has(name)) {
          unbound.push({ importer: asset.url, file: asset.file, target: target.url, name });
        }
      }
    }
  }
  return unbound;
}

/** Refuses a bundle whose outputs do not link, naming the first import that binds nothing. */
export function refuseUnboundImports(assets: readonly LinkedAsset[]): void {
  const [first] = unboundImports(assets);
  if (first === undefined) return;
  throw new IslandBuildFailedError({
    file: first.file ?? first.importer,
    logs: `${first.importer} imports ${first.name} from ${first.target}, which exports no such name, so the island would fail to link in the browser — clear the island cache with rm -rf .x/cache/islands and build again`,
  });
}
