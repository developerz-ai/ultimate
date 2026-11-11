// One split `Bun.build` of every island, turned into the files a browser fetches: an entry per
// island and a chunk per module two or more islands share, each named by a hash of its FINAL
// bytes and importing the others by that name. `island-bundle.ts` runs the build; this only links.
//
// Why the names are rewritten rather than taken from Bun's `chunk-[hash]`: every import of another
// output is rewritten here, so Bun's hash is of bytes no browser receives. And why the hash is of
// the OUTPUT, never the sources (#1075): the minifier names a shared chunk's exports by how often
// the WHOLE build uses them, so an edit to one entry swapped `var g=q(…),y=Fe(…)` for
// `var y=q(…),g=Fe(…)` in a chunk whose sources had not moved. Named by its sources, it kept its
// URL, and a CDN holding the old copy under `immutable` handed the new islands the wrong export.

import { posix } from 'node:path'; // why: Bun ships no path API; `basename` of a specifier.
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
}

export interface LinkedFile {
  /** The output this came from, so the caller can pair it with its island. */
  readonly path: string;
  readonly file?: string;
  /** `contentHash(code)`: `chunk-<identity>` shared, `<moduleId>-<identity>` an entry. */
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

/** Specifiers exactly as written, each naming another output of this build. */
function specifiersOf(code: string, byName: ReadonlyMap<string, BuiltOutput>): readonly string[] {
  const scanned = new Bun.Transpiler({ loader: 'js' }).scan(code);
  const specifiers = scanned.imports
    .filter((one) => LOADS.has(one.kind) && byName.has(posix.basename(one.path)))
    .map((one) => one.path);
  return [...new Set(specifiers)];
}

/**
 * Every output linked, leaves first: an output's bytes NAME the chunks it imports, so its final
 * code — and so its name — exists only once theirs do. The identity is `contentHash` of exactly the
 * code returned, so one name is one byte string across every build that ever emits it.
 */
export function linkOutputs(outputs: readonly BuiltOutput[]): readonly LinkedFile[] {
  const byName = new Map(outputs.map((one) => [posix.basename(one.path), one]));
  const linked = new Map<string, LinkedFile>();
  const visiting = new Set<string>();

  const link = (output: BuiltOutput): LinkedFile => {
    const known = linked.get(output.path);
    if (known !== undefined) return known;
    if (visiting.has(output.path)) throw cycle(output);
    visiting.add(output.path);
    let code = output.code;
    const imports: string[] = [];
    for (const spec of specifiersOf(output.code, byName)) {
      const dep = byName.get(posix.basename(spec));
      if (dep === undefined) continue;
      const name = sharedChunkName(link(dep).identity);
      imports.push(name);
      // The quoted literal, whole: Bun writes every specifier double-quoted, and a chunk name is a
      // hash no program text contains by accident. Relative, so it resolves beside the importer
      // under any base path — `/islands/` served, a temp directory in `mountIsland`.
      code = code.split(JSON.stringify(spec)).join(JSON.stringify(`./${name}`));
    }
    const done: LinkedFile = {
      path: output.path,
      ...(output.file === undefined ? {} : { file: output.file }),
      identity: contentHash(code),
      code,
      imports: [...new Set(imports)].sort(),
    };
    visiting.delete(output.path);
    linked.set(output.path, done);
    return done;
  };

  return outputs.map(link);
}

/**
 * Two outputs importing each other: esbuild-family splitting does not emit one between chunks, and
 * a name that is a hash of bytes containing the other's name has no answer for it. Refused by
 * name rather than answered with a name that ignores an edge.
 */
function cycle(output: BuiltOutput): IslandBuildFailedError {
  return new IslandBuildFailedError({
    file: output.file ?? output.path,
    logs: `the island build emitted a chunk import cycle through ${output.path}, so its outputs cannot each be named by their own bytes`,
  });
}
