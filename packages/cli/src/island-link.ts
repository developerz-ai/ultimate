// One split `Bun.build` of every island, turned into the files a browser fetches: an entry per
// island and a chunk per module two or more islands share, each named by its SOURCE identity and
// importing the others by that name. `island-bundle.ts` runs the build; this file only links.
//
// Why the names are rewritten rather than taken from Bun's `chunk-[hash]`: that hash is of the
// OUTPUT, and `Bun.build` under `minify` is not byte-deterministic (`graphHash` in
// `island-bundle.ts` has the measurement). An output-addressed shared chunk flaps its URL, and
// every entry importing it flaps with it — the precache-404 and cold-cache defect, back.

import { posix } from 'node:path'; // why: Bun ships no path API; `basename` of a specifier.
import { frameworkVersion } from '@ultimat3/core';
import { contentHash } from '@ultimat3/render/server';
import { IslandBuildFailedError } from './errors';

/** One code output of the build, as `island-bundle.ts` hands it over. */
export interface BuiltOutput {
  /** Bun's own output path, `./` stripped: `apps/web/app/x.island.js`, `chunk-ab12cd34.js`. */
  readonly path: string;
  /** The island file it is the entry for; `undefined` for a shared chunk. */
  readonly file?: string;
  /** Emitted code, the debug-id comment already removed. */
  readonly code: string;
  /** Its source map's `sourcesContent` — empty for a chunk of bundler runtime helpers only. */
  readonly sources: readonly string[];
}

export interface LinkedFile {
  /** The output this came from, so the caller can pair it with its island. */
  readonly path: string;
  readonly file?: string;
  /** `chunk-<identity>` for a shared chunk; the caller prefixes an entry with its module id. */
  readonly identity: string;
  /** The code with every import of another output rewritten to that output's final name. */
  readonly code: string;
  /** Final basenames of the outputs this one imports, statically or by `import()`, direct only. */
  readonly imports: readonly string[];
}

/** The final basename a shared chunk is served under — beside every entry, under one base path. */
export const sharedChunkName = (identity: string): string => `chunk-${identity}.js`;

/** Static imports and `import()` both: a browser fetches either before the island is whole. */
const LOADS = new Set(['import-statement', 'dynamic-import']);

interface Scanned {
  readonly exports: readonly string[];
  /** Specifiers exactly as written, each naming another output of this build. */
  readonly specifiers: readonly string[];
}

function scan(code: string, byName: ReadonlyMap<string, BuiltOutput>): Scanned {
  const scanned = new Bun.Transpiler({ loader: 'js' }).scan(code);
  const specifiers = scanned.imports
    .filter((one) => LOADS.has(one.kind) && byName.has(posix.basename(one.path)))
    .map((one) => one.path);
  return { exports: [...scanned.exports].sort(), specifiers: [...new Set(specifiers)] };
}

/**
 * Every output's identity, from what went in: its own sources (hashed and sorted, as `graphHash`
 * does), its EXPORT names, and the identities of every output it imports. The exports are in it
 * because they are the link between two files built together — an importer's `import{a as o}`
 * is only correct against a chunk exporting `a`, so a chunk whose interface moved must not keep a
 * URL an older importer is holding. The imports are in it because an entry's bytes NAME its
 * chunks: a moved chunk moves every entry that loads it.
 */
export function linkOutputs(outputs: readonly BuiltOutput[]): readonly LinkedFile[] {
  const byName = new Map(outputs.map((one) => [posix.basename(one.path), one]));
  const scans = new Map(outputs.map((one) => [one.path, scan(one.code, byName)]));
  const identities = new Map<string, string>();
  const visiting = new Set<string>();

  const identityOf = (output: BuiltOutput): string => {
    const known = identities.get(output.path);
    if (known !== undefined) return known;
    if (visiting.has(output.path)) throw cycle(output);
    visiting.add(output.path);
    const scanned = scans.get(output.path) ?? { exports: [], specifiers: [] };
    const deps = scanned.specifiers
      .map((spec) => byName.get(posix.basename(spec)))
      .filter((dep): dep is BuiltOutput => dep !== undefined)
      .map(identityOf)
      .sort();
    // A chunk of bundler runtime helpers has no source file behind it — its code IS its source.
    const own = output.sources.length === 0 ? [contentHash(output.code)] : output.sources;
    const identity = contentHash(
      [
        output.file ?? 'shared',
        frameworkVersion(),
        Bun.version,
        ...own.map((source) => contentHash(source)).sort(),
        'exports',
        ...scanned.exports,
        'imports',
        ...deps,
      ].join('\u0000'),
    );
    visiting.delete(output.path);
    identities.set(output.path, identity);
    return identity;
  };

  return outputs.map((output) => {
    const identity = identityOf(output);
    const scanned = scans.get(output.path) ?? { exports: [], specifiers: [] };
    let code = output.code;
    const imports: string[] = [];
    for (const spec of scanned.specifiers) {
      const dep = byName.get(posix.basename(spec));
      if (dep === undefined) continue;
      const name = sharedChunkName(identityOf(dep));
      imports.push(name);
      // The quoted literal, whole: Bun writes every specifier double-quoted, and a chunk name is a
      // hash no program text contains by accident. Relative, so it resolves beside the importer
      // under any base path — `/islands/` served, a temp directory in `mountIsland`.
      code = code.split(JSON.stringify(spec)).join(JSON.stringify(`./${name}`));
    }
    return {
      path: output.path,
      ...(output.file === undefined ? {} : { file: output.file }),
      identity,
      code,
      imports: [...new Set(imports)].sort(),
    };
  });
}

/**
 * Two outputs importing each other: esbuild-family splitting does not emit one, and an identity
 * built from its imports' identities has no answer for it. Refused by name rather than answered
 * with a hash that silently ignores an edge.
 */
function cycle(output: BuiltOutput): IslandBuildFailedError {
  return new IslandBuildFailedError({
    file: output.file ?? output.path,
    logs: `the island build emitted a chunk import cycle through ${output.path}, so its outputs have no source identity to be named by`,
  });
}
