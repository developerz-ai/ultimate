// The one lcov reader: what `bun test --coverage --coverage-reporter=lcov` wrote, as per-file
// facts, and how the facts of several test processes add up. `scripts/coverage-gate.ts` (the
// framework's packages) and `coverage-floor.ts` (an app) both read through it.

/** One `SF:` record, as written: its own totals and every `DA:` line. */
export interface LcovRecord {
  /** The `SF:` path, verbatim — Bun writes it relative to the directory the run started in. */
  readonly file: string;
  /** `LF` / `LH` / `FNF` / `FNH`. Bun's lcov carries no `FN:` lines, so functions are counts only. */
  readonly linesFound: number;
  readonly linesHit: number;
  readonly funcsFound: number;
  readonly funcsHit: number;
  /** line → hits. */
  readonly lines: ReadonlyMap<number, number>;
}

export function parseLcov(text: string): readonly LcovRecord[] {
  const records: LcovRecord[] = [];
  let file: string | undefined;
  let lf = 0;
  let lh = 0;
  let fnf = 0;
  let fnh = 0;
  let lines = new Map<number, number>();
  for (const line of text.split('\n')) {
    if (line.startsWith('SF:')) {
      file = line.slice(3);
      lf = 0;
      lh = 0;
      fnf = 0;
      fnh = 0;
      lines = new Map();
    } else if (file === undefined) {
      // Before the first record (`TN:`), or between two.
    } else if (line.startsWith('DA:')) {
      const comma = line.indexOf(',');
      const at = Number(line.slice(3, comma));
      const hits = Number(line.slice(comma + 1));
      if (comma > 3 && Number.isSafeInteger(at) && Number.isFinite(hits)) lines.set(at, hits);
    } else if (line.startsWith('LF:')) lf = Number(line.slice(3));
    else if (line.startsWith('LH:')) lh = Number(line.slice(3));
    else if (line.startsWith('FNF:')) fnf = Number(line.slice(4));
    else if (line.startsWith('FNH:')) fnh = Number(line.slice(4));
    else if (line === 'end_of_record') {
      records.push({
        file,
        linesFound: lf,
        linesHit: lh,
        funcsFound: fnf,
        funcsHit: fnh,
        lines,
      });
      file = undefined;
    }
  }
  return records;
}

/** One source file's coverage: which lines ran, which could have and did not, and its functions. */
export interface FileCoverage {
  readonly hit: readonly number[];
  readonly miss: readonly number[];
  readonly funcsFound: number;
  readonly funcsHit: number;
}

export const fileCoverageOf = (record: LcovRecord): FileCoverage => {
  const hit: number[] = [];
  const miss: number[] = [];
  for (const [line, hits] of record.lines) (hits > 0 ? hit : miss).push(line);
  return { hit, miss, funcsFound: record.funcsFound, funcsHit: record.funcsHit };
};

/**
 * One file's coverage across several test PROCESSES.
 *
 * A line is covered when any process ran it. It is uncovered only when EVERY process that loaded
 * the file lists it as unrun — because Bun lists a function nothing called in that process by its
 * whole line range, comments and blank lines included, and lists a function that ran by its
 * executable lines alone. A union therefore counts the comments of every function one process
 * called and another merely loaded, and the number moves with how the files were dealt:
 * `examples/dummy` read 59.9% at four workers, 65.0% at two and 65.5% in one process, same tree
 * (measured 2026-10-01, Bun 1.4.0, whose own `--parallel` merge is that union). This rule read
 * 65.90% for 2, 4 and 8 processes and for contiguous chunks — and is exactly what Bun reports for
 * one `--isolate` process.
 *
 * Functions have no identity in Bun's lcov, only two counts, so they cannot be unioned: the file
 * takes the best any one process reached. That is a lower bound, and the reason the processes are
 * cut along directories (`verify-coverage-run.ts`) — the tests beside a file run together.
 */
export function mergeFileCoverage(parts: readonly FileCoverage[]): FileCoverage {
  if (parts.length === 1) return parts[0] as FileCoverage;
  const hit = new Set<number>();
  for (const part of parts) for (const line of part.hit) hit.add(line);
  const missIn = parts.map((part) => new Set(part.miss));
  const miss = [...(missIn[0] ?? [])].filter(
    (line) => !hit.has(line) && missIn.every((set) => set.has(line)),
  );
  return {
    hit: [...hit].sort((a, b) => a - b),
    miss: miss.sort((a, b) => a - b),
    funcsFound: Math.max(0, ...parts.map((part) => part.funcsFound)),
    funcsHit: Math.max(0, ...parts.map((part) => part.funcsHit)),
  };
}

/** file → coverage. A plain record so it survives `--json` between a shard and `x verify merge`. */
export type CoverageMap = Readonly<Record<string, FileCoverage>>;

/** Several processes' (or several shards') maps as one, file by file. */
export function mergeCoverage(maps: readonly CoverageMap[]): CoverageMap {
  const byFile = new Map<string, FileCoverage[]>();
  for (const map of maps) {
    for (const [file, coverage] of Object.entries(map)) {
      const list = byFile.get(file) ?? [];
      list.push(coverage);
      byFile.set(file, list);
    }
  }
  return Object.fromEntries(
    [...byFile]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([file, parts]) => [file, mergeFileCoverage(parts)]),
  );
}

/** `hit / found` as a percentage to two decimals; nothing found is 0, never a pass over nothing. */
export const percent = (hit: number, found: number): number =>
  found === 0 ? 0 : Math.round((hit / found) * 10_000) / 100;

/** `[1,2,3,7]` → `"1-3,7"`: a shard's facts ride in its `--json` document, so they are kept small. */
export function encodeLines(lines: readonly number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const runs: string[] = [];
  let start: number | undefined;
  let last = 0;
  const flush = (): void => {
    if (start !== undefined) runs.push(start === last ? String(start) : `${start}-${last}`);
  };
  for (const line of sorted) {
    if (start !== undefined && line === last + 1) {
      last = line;
      continue;
    }
    flush();
    start = line;
    last = line;
  }
  flush();
  return runs.join(',');
}

/** The inverse of `encodeLines`; a run that does not parse is no lines, never a throw. */
export function decodeLines(text: string): readonly number[] {
  const lines: number[] = [];
  for (const run of text.split(',')) {
    const match = /^(\d+)(?:-(\d+))?$/.exec(run);
    if (match === null) continue;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    for (let line = from; line <= to && line - from < 1_000_000; line += 1) lines.push(line);
  }
  return lines;
}

/** A file's facts as they cross `--json`: hit runs, miss runs, `[funcsFound, funcsHit]`. */
export type CoverageWire = Readonly<
  Record<string, { readonly h: string; readonly m: string; readonly f: readonly [number, number] }>
>;

export const encodeCoverage = (map: CoverageMap): CoverageWire =>
  Object.fromEntries(
    Object.entries(map).map(([file, one]) => [
      file,
      { h: encodeLines(one.hit), m: encodeLines(one.miss), f: [one.funcsFound, one.funcsHit] },
    ]),
  );

/** A part's `data.coverage.<step>` back into a map, or nothing when it is not one. */
export function decodeCoverage(value: unknown): CoverageMap | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const out = new Map<string, FileCoverage>();
  for (const [file, raw] of Object.entries(value)) {
    if (typeof raw !== 'object' || raw === null) return undefined;
    const { h, m, f } = raw as { h?: unknown; m?: unknown; f?: unknown };
    if (typeof h !== 'string' || typeof m !== 'string' || !Array.isArray(f)) return undefined;
    const [found, hit] = f as unknown[];
    if (typeof found !== 'number' || typeof hit !== 'number') return undefined;
    out.set(file, { hit: decodeLines(h), miss: decodeLines(m), funcsFound: found, funcsHit: hit });
  }
  return Object.fromEntries(out);
}
