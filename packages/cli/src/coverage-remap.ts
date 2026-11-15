// An island chunk's lcov lines, credited back to the app sources it was built from through the
// chunk's own source map. Pure: the sidecar text, the record and the files on disk come in, and
// per-source line facts go out. `coverage-island.ts` does the reading.

import { stripComments } from '@ultimat3/core';
import type { FileCoverage, LcovRecord } from './coverage-lcov';

/** One chunk's map as `mountIsland` recorded it: the build's cwd, its `sources` and their text. */
export interface ChunkMap {
  /** The chunk's file name as the test process imported it — the basename of its `SF:` line. */
  readonly module: string;
  /** Every `sources` entry resolved to an absolute POSIX path (Bun writes them cwd-relative). */
  readonly sources: readonly string[];
  readonly sourcesContent: readonly (string | undefined)[];
  readonly mappings: string;
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** One segment's base64-VLQ fields, or nothing when a character is not base64. */
function vlqFields(segment: string): readonly number[] | undefined {
  const fields: number[] = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = BASE64.indexOf(ch);
    if (digit === -1) return undefined;
    value += (digit & 31) * 2 ** shift;
    if ((digit & 32) === 0) {
      fields.push(value % 2 === 1 ? -(value - 1) / 2 : value / 2);
      value = 0;
      shift = 0;
    } else shift += 5;
  }
  return fields;
}

/**
 * Generated line (0-based) → the source index and 0-based original line of its FIRST mapped
 * segment. The first segment only: a generated line that folds several original lines ran at least
 * where it starts, and crediting every line it folds is how a minified two-line chunk would claim
 * the whole island. An undercount, never a claim.
 *
 * A segment that names exactly the position the one before it named is skipped: Bun maps a line's
 * leading indent back to where the PREVIOUS statement ended (`AAAA`), so taking it credited every
 * indented line to the line above it (measured, Bun 1.4.4).
 */
export function firstSegments(
  mappings: string,
): readonly (readonly [number, number] | undefined)[] {
  const out: (readonly [number, number] | undefined)[] = [];
  let source = 0;
  let line = 0;
  let seen = false;
  for (const generated of mappings.split(';')) {
    let first: readonly [number, number] | undefined;
    for (const segment of generated.split(',')) {
      const fields = segment === '' ? undefined : vlqFields(segment);
      if (fields === undefined || fields.length < 4) continue;
      source += fields[1] as number;
      line += fields[2] as number;
      const carried = seen && fields[1] === 0 && fields[2] === 0 && fields[3] === 0;
      seen = true;
      if (!carried) first ??= [source, line];
    }
    out.push(first);
  }
  return out;
}

/** What one chunk says about one source: the 1-based lines it ran and the ones it did not. */
export interface ChunkLines {
  readonly hit: ReadonlySet<number>;
  readonly miss: ReadonlySet<number>;
}

/**
 * The chunk's `DA:` lines as lines of the app's sources. `relativeOf` keys a source (absolute
 * path) the way the app's coverage is keyed, or refuses it; `disk` is that file's text now.
 *
 * A line is credited only when the text the chunk was built from holds, at that line number, the
 * same non-blank text the file holds on disk. A plugin that rewrote the file (Babel's Solid
 * transform without `retainLines`) moves every line, and a map then points at lines of code the
 * file does not have there: those are dropped rather than credited to whatever sits at that number.
 */
export function chunkLines(
  record: LcovRecord,
  map: ChunkMap,
  relativeOf: (absolute: string) => string | undefined,
  disk: (relative: string) => string | undefined,
): ReadonlyMap<string, ChunkLines> {
  const segments = firstSegments(map.mappings);
  const keys = map.sources.map(relativeOf);
  const built = map.sourcesContent.map((text) => text?.split('\n'));
  const now = keys.map((key) => (key === undefined ? undefined : disk(key)?.split('\n')));
  const out = new Map<string, { hit: Set<number>; miss: Set<number> }>();
  for (const [generated, hits] of record.lines) {
    const at = segments[generated - 1];
    if (at === undefined) continue;
    const [index, zeroLine] = at;
    const key = keys[index];
    const text = built[index]?.[zeroLine]?.trim();
    if (key === undefined || text === undefined || text === '') continue;
    if (now[index]?.[zeroLine]?.trim() !== text) continue;
    const facts = out.get(key) ?? { hit: new Set<number>(), miss: new Set<number>() };
    (hits > 0 ? facts.hit : facts.miss).add(zeroLine + 1);
    out.set(key, facts);
  }
  for (const facts of out.values()) for (const line of facts.hit) facts.miss.delete(line);
  return out;
}

/**
 * A source's coverage once a chunk's lines are added to it.
 *
 * Loaded directly too (`base`): a line the direct record missed and the chunk ran becomes hit, and
 * nothing else moves — the line set stays the one Bun counted, so the chunk can only turn misses
 * into hits. Functions keep the direct record's counts: Bun's lcov names no function, so which of
 * the chunk's functions belong to this file is unknowable, and the direct count is a lower bound.
 *
 * Not loaded directly anywhere: every non-blank, non-comment line of `source` is a line, hit where
 * the chunk ran it — the heavy line set an unloaded file weighs (`unloadedWeight`). Functions are
 * `0 / 0`, NOT the unloaded estimate: shards fold by taking the best function count any of them
 * reached (`mergeFileCoverage`), so an estimate here beside a shard that loaded the file directly
 * replaced its real denominator — measured on `examples/dummy`, functions fell 67.0% → 63.4%.
 */
export function withChunkLines(
  base: FileCoverage | undefined,
  lines: ChunkLines,
  source: string,
): FileCoverage {
  if (base !== undefined) {
    const turned = base.miss.filter((line) => lines.hit.has(line));
    if (turned.length === 0) return base;
    return {
      ...base,
      hit: [...base.hit, ...turned].sort((a, b) => a - b),
      miss: base.miss.filter((line) => !lines.hit.has(line)),
    };
  }
  const hit: number[] = [];
  const miss: number[] = [];
  stripComments(source)
    .split('\n')
    .forEach((text, index) => {
      if (text.trim() !== '') (lines.hit.has(index + 1) ? hit : miss).push(index + 1);
    });
  return { hit, miss, funcsFound: 0, funcsHit: 0 };
}
