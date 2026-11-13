// One tree's public surface as the lock records it: every publishable package's entries emitted
// by `tsc`, each exported symbol's normalised text hashed and shaped. The working tree and a
// release tag's (`public-api-migrate.ts`) are read by this one function.

import type { ApiSymbol } from './public-api-compat';
import type { ApiEntry, ApiPackage } from './public-api-emit';
import { dtsPathOf, emitDeclarations, packageEntries } from './public-api-emit';
import type { ApiSnapshot } from './public-api-lock';
import { shapeOf } from './public-api-shape';
import { digest, symbolReader } from './public-api-symbols';

export type Surface =
  | { readonly ok: true; readonly entries: readonly ApiEntry[]; readonly tree: ApiSnapshot }
  | { readonly ok: false; readonly entries: readonly ApiEntry[]; readonly problem: string };

/** name → text, as hash and shape. */
export function symbolsOf(texts: Readonly<Record<string, string>>): Record<string, ApiSymbol> {
  const out: Record<string, ApiSymbol> = {};
  for (const [name, text] of Object.entries(texts)) {
    const shape = shapeOf(text);
    out[name] = shape === undefined ? { hash: digest(text) } : { hash: digest(text), shape };
  }
  return out;
}

/** The surface of the tree at `root`, compiled by `tsc`. */
export async function readSurface(
  root: string,
  packages: readonly ApiPackage[],
  tsc?: string,
): Promise<Surface> {
  const entries: ApiEntry[] = [];
  for (const pkg of packages) entries.push(...(await packageEntries(root, pkg)));
  if (entries.length === 0) return { ok: false, entries, problem: 'no entries' };
  const emitted = await emitDeclarations(root, entries, tsc);
  if (!emitted.ok) return { ok: false, entries, problem: emitted.problem };
  const read = symbolReader(emitted.tree);
  const tree: Record<string, Record<string, ApiSymbol>> = {};
  for (const entry of entries) tree[entry.specifier] = symbolsOf(read(dtsPathOf(entry.source)));
  return { ok: true, entries, tree };
}
