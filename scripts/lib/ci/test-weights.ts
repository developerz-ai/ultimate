// The committed per-file test weights ci.yml's gate shards are dealt on (`x verify --shard i/n
// --timings <file>`): read from one CI run's artifacts, kept only where a part measured the file
// itself, rendered canonically, and the shard loads they predict. The writer is
// `scripts/test-weights.ts`; the dealer is `shardFiles` (packages/cli/src/verify-shard.ts).

// why: Bun ships no path-join primitive.
import { join } from 'node:path';
import type { Timings } from '../../../packages/cli/src/verify-shard';
import { shardFiles } from '../../../packages/cli/src/verify-shard';

/** Repo-relative: the file every gate shard passes to `--timings`, and the slow-test guard reads. */
export const WEIGHTS_FILE = 'scripts/lib/ci/test-weights.json';

/** The committed document. `files` is repo-relative test path → integer wall ms on a CI runner. */
export interface TestWeights {
  readonly measuredAt: string;
  readonly source: string;
  readonly files: Readonly<Record<string, number>>;
}

/** One gate part's artifacts: the files its shard ran, per step, and the timings it uploaded. */
export interface MeasuredPart {
  readonly part: string;
  readonly attempt: number;
  readonly ran: Readonly<Record<string, readonly string[]>>;
  readonly timings: Timings;
}

/** Every step's files, over every part: the corpus each step's shards split, as `{ step: files }`. */
export const corpusOf = (parts: readonly MeasuredPart[]): Record<string, string[]> => {
  // A Map, never a record: a step name is read off an artifact, and `constructor` must not resolve.
  const corpus = new Map<string, Set<string>>();
  for (const part of parts) {
    for (const [step, files] of Object.entries(part.ran)) {
      const seen = corpus.get(step) ?? new Set<string>();
      for (const file of files) seen.add(file);
      corpus.set(step, seen);
    }
  }
  return Object.fromEntries([...corpus].map(([step, set]) => [step, [...set].sort()]));
};

const finiteMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * Every file some part RAN, at the duration that part measured. A part's timings file also holds
 * the whole cache it restored, stale for every file another part ran — so only `ran` is read, and
 * of a part re-run, only its newest attempt.
 */
export function freshWeights(parts: readonly MeasuredPart[]): Record<string, number> {
  const newest = new Map<string, MeasuredPart>();
  for (const part of parts) {
    const seen = newest.get(part.part);
    if (seen === undefined || part.attempt > seen.attempt) newest.set(part.part, part);
  }
  const files: Record<string, number> = {};
  for (const part of newest.values()) {
    for (const file of Object.values(part.ran).flat()) {
      const ms = Object.hasOwn(part.timings, file) ? part.timings[file] : undefined;
      if (finiteMs(ms)) files[file] = Math.round(ms);
    }
  }
  return files;
}

/** The one spelling of the file: sorted keys, two-space JSON, a trailing newline. */
export const renderWeights = (weights: TestWeights): string => {
  const files = Object.fromEntries(
    Object.keys(weights.files)
      .sort()
      .map((file) => [file, weights.files[file]]),
  );
  return `${JSON.stringify({ measuredAt: weights.measuredAt, source: weights.source, files }, null, 2)}\n`;
};

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

/** The document, or why it is not one. */
export function parseWeights(raw: unknown): TestWeights | string {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'not a JSON object';
  const { measuredAt, source, files } = raw as Record<string, unknown>;
  if (typeof measuredAt !== 'string' || !ISO.test(measuredAt)) {
    return 'measuredAt is not an ISO-8601 UTC instant';
  }
  if (typeof source !== 'string' || source.trim() === '') return 'source is empty';
  if (typeof files !== 'object' || files === null || Array.isArray(files)) {
    return 'files is not an object of { "path": ms }';
  }
  for (const [file, ms] of Object.entries(files)) {
    if (!Number.isSafeInteger(ms) || (ms as number) < 0) {
      return `files["${file}"] is not a whole number of ms`;
    }
  }
  return { measuredAt, source, files: files as Record<string, number> };
}

const ARTIFACT = /^(?:test-timings|verify-part)-(.+)-attempt-(\d+)$/;

const readJson = async (path: string): Promise<unknown> => {
  try {
    return JSON.parse(await Bun.file(path).text());
  } catch {
    return undefined;
  }
};

/** `steps[].shard.files` of a part's `--json` document, by step; none for an unsharded part. */
const ranBy = (doc: unknown): Record<string, readonly string[]> => {
  const steps = (doc as { steps?: unknown } | undefined)?.steps;
  if (!Array.isArray(steps)) return {};
  const ran: Record<string, readonly string[]> = {};
  for (const step of steps as unknown[]) {
    const { name, shard } = (step ?? {}) as { name?: unknown; shard?: { files?: unknown } };
    const files = shard?.files;
    if (typeof name !== 'string' || !Array.isArray(files)) continue;
    ran[name] = files.filter((file): file is string => typeof file === 'string');
  }
  return ran;
};

/**
 * A run's artifacts as `gh run download <id> -D <dir>` lays them out: one directory per artifact,
 * `test-timings-<part>-attempt-<n>/test-timings.json` beside `verify-part-<part>-attempt-<n>/*.json`.
 * A timings artifact with no document is `unpaired`: nothing says which of its entries are fresh.
 */
export async function readMeasuredParts(
  dir: string,
): Promise<{ readonly parts: readonly MeasuredPart[]; readonly unpaired: readonly string[] }> {
  const docs = new Map<string, unknown>();
  for (const path of new Bun.Glob('verify-part-*/*.json').scanSync({ cwd: dir })) {
    const name = path.split(/[\\/]/)[0] ?? '';
    docs.set(name.replace(/^verify-part-/, ''), await readJson(join(dir, path)));
  }
  const parts: MeasuredPart[] = [];
  const unpaired: string[] = [];
  const timingsFiles = [...new Bun.Glob('test-timings-*/test-timings.json').scanSync({ cwd: dir })];
  for (const path of timingsFiles.sort()) {
    const name = path.split(/[\\/]/)[0] ?? '';
    const match = ARTIFACT.exec(name);
    const key = name.replace(/^test-timings-/, '');
    const doc = docs.get(key);
    const ran = ranBy(doc);
    const raw = await readJson(join(dir, path));
    const files =
      typeof raw === 'object' && raw !== null && 'files' in raw
        ? (raw as { files: unknown }).files
        : raw;
    if (
      match === null ||
      Object.keys(ran).length === 0 ||
      typeof files !== 'object' ||
      files === null
    ) {
      unpaired.push(name);
      continue;
    }
    parts.push({
      part: match[1] as string,
      attempt: Number(match[2]),
      ran,
      timings: files as Timings,
    });
  }
  return { parts, unpaired };
}

/**
 * Each shard's summed cost over every step's corpus (`{ step: files }`), dealt as the gate deals:
 * by the weights (`weighted`) or round-robin. A file the weights do not know costs their median
 * over that step's files, as in `shardFiles`.
 */
export function predictedLoads(
  corpus: Readonly<Record<string, readonly string[]>>,
  weights: Timings,
  total: number,
  weighted: boolean,
): number[] {
  const loads = Array.from({ length: total }, () => 0);
  for (const files of Object.values(corpus)) {
    const known = files
      .map((file) => (Object.hasOwn(weights, file) ? weights[file] : undefined))
      .filter(finiteMs)
      .sort((a, b) => a - b);
    const median = known.length === 0 ? 1 : (known[Math.floor(known.length / 2)] as number);
    const cost = (file: string): number => {
      const ms = Object.hasOwn(weights, file) ? weights[file] : undefined;
      return finiteMs(ms) ? ms : median;
    };
    for (let index = 1; index <= total; index += 1) {
      const dealt = shardFiles(files, { index, total }, weighted ? weights : undefined).files;
      loads[index - 1] = (loads[index - 1] as number) + dealt.reduce((s, f) => s + cost(f), 0);
    }
  }
  return loads;
}
