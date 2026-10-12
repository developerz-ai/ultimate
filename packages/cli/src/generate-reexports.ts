// Single responsibility: reading a slice module's relative `export * from './x'` targets off the
// app's disk, one level deep, so a barrel is judged by what it really exports.

// why: Bun has no synchronous "is this a FILE": a directory passes `existsSync`, and reading one
// as a file is an uncoded EISDIR.
import { statSync } from 'node:fs';
import { containedPath } from './generate-write';
import { inlineReexports } from './templates/slice-foundation';

/**
 * A slice module with its relative `export * from './x'` lines read in, one level deep — so a
 * `policy.ts` that is a barrel is judged by what it really exports (`inlineReexports`).
 */
export async function followReexports(
  root: string,
  slice: string,
  source: string | undefined,
): Promise<string | undefined> {
  if (source === undefined) return undefined;
  const found = new Map<string, string>();
  for (const match of source.matchAll(/\bexport\s*\*\s*from\s*['"](\.[^'"]+)['"]/g)) {
    const specifier = match[1] ?? '';
    for (const candidate of [`${specifier}.ts`, `${specifier}/index.ts`, specifier]) {
      const file = containedPath(root, `${slice}/${candidate}`);
      // A FILE, or it is not followed: `./rules` naming a directory with no `index.ts` is left as
      // the `export *` it was, which is "cannot tell".
      if (found.has(specifier) || !isFile(file)) continue;
      found.set(specifier, await Bun.file(file).text());
    }
  }
  return inlineReexports(source, (specifier) => found.get(specifier));
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
