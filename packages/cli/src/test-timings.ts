// The per-file test durations a run learns and the next one spends: read leniently from the local
// cache (`TEST_TIMINGS_FILE`, Bun's own `--timings` shape), merged and written back atomically, the
// slowest files of a run named on its step, and work ordered longest-first by them. A cache only
// ever orders work and names what was slow — never which files run or what a step answers — so a
// missing, stale or broken one costs seconds, never a verdict.

// why: Bun has no mkdir or rename; the cache is written to a temp name and renamed into place.
import { mkdir, rename, rm } from 'node:fs/promises';
// why: Bun ships no path-join primitive.
import { dirname } from 'node:path';
import type { SlowFile } from './output';
import type { Timings } from './verify-shard';

/** How many of a run's slowest files a step carries (`--json`); the human line shows fewer. */
export const SLOWEST_KEPT = 10;

const finiteMs = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0;

/** The cache as `{ path: ms }`; absent, unreadable or of another shape is `{}` — never a throw. */
export async function loadTimings(path: string): Promise<Timings> {
  try {
    const parsed: unknown = JSON.parse(await Bun.file(path).text());
    const files =
      typeof parsed === 'object' && parsed !== null && 'files' in parsed
        ? (parsed as { files: unknown }).files
        : parsed;
    if (typeof files !== 'object' || files === null || Array.isArray(files)) return {};
    return Object.fromEntries(Object.entries(files).filter(([, ms]) => finiteMs(ms)));
  } catch {
    return {};
  }
}

/**
 * `fresh` merged over the cache and written back in Bun's own shape (`{ version: 1, files }`), so
 * `bun test --timings` reads what this wrote and the other way round. Best effort: a cache that
 * cannot be written costs the next run its ordering, which is all it ever bought.
 */
export async function recordTimings(path: string, fresh: Timings): Promise<void> {
  if (Object.keys(fresh).length === 0) return;
  const files = { ...(await loadTimings(path)), ...fresh };
  const partial = `${path}.${String(process.pid)}.${crypto.randomUUID()}.partial`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(partial, `${JSON.stringify({ version: 1, files }, null, 2)}\n`);
    await rename(partial, path);
  } catch {
    await rm(partial, { force: true }).catch(() => undefined);
  }
}

const attribute = (tag: string, name: string): string | undefined => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match === null ? undefined : match[1];
};

/** XML's five entities, the only ones Bun's junit writer emits in an attribute. */
const unescapeXml = (text: string): string =>
  text
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

/**
 * Per-file durations from a `bun test --reporter=junit` report: each file is one `<testsuite>`
 * whose `file` (else `name`) is the path as the run was given it and whose `time` is seconds.
 * Nested suites (a `describe`) carry no `file` and are skipped. A broken report yields `{}`.
 */
export function junitDurations(xml: string): Timings {
  const out: Record<string, number> = {};
  for (const match of xml.matchAll(/<testsuite\s[^>]*>/g)) {
    const tag = match[0];
    const file = attribute(tag, 'file');
    const seconds = Number(attribute(tag, 'time'));
    if (file === undefined || file === '' || !finiteMs(seconds)) continue;
    const path = unescapeXml(file);
    out[path] = Math.round(seconds * 1000) + (out[path] ?? 0);
  }
  return out;
}

/** The `n` slowest of `files` by `timings`, slowest first (ties by path); unknown files left out. */
export function slowestOf(
  timings: Timings,
  files: readonly string[],
  n: number = SLOWEST_KEPT,
): readonly SlowFile[] {
  return [...new Set(files)]
    .flatMap((file) => {
      const ms = Object.hasOwn(timings, file) ? timings[file] : undefined;
      return finiteMs(ms) ? [{ file, ms }] : [];
    })
    .sort((a, b) => b.ms - a.ms || (a.file < b.file ? -1 : a.file > b.file ? 1 : 0))
    .slice(0, Math.max(0, n));
}

/**
 * Indices of `costs` longest first (LPT): a pool that starts its longest piece of work last finishes
 * that long after everything else. An unknown cost (`undefined`) is the median of the known ones,
 * so new work neither jumps the queue nor waits behind all of it; ties keep their order.
 */
export function longestFirst(costs: readonly (number | undefined)[]): readonly number[] {
  const known = costs.filter((cost): cost is number => finiteMs(cost)).sort((a, b) => a - b);
  const median = known.length === 0 ? 0 : (known[Math.floor(known.length / 2)] as number);
  const costOf = (index: number): number => {
    const cost = costs[index];
    return finiteMs(cost) ? cost : median;
  };
  return costs.map((_, index) => index).sort((a, b) => costOf(b) - costOf(a) || a - b);
}

/** A group of files' recorded cost: the sum of what is known, `undefined` when nothing is. */
export function costOf(timings: Timings, files: readonly string[]): number | undefined {
  let total = 0;
  let known = false;
  for (const file of files) {
    const ms = Object.hasOwn(timings, file) ? timings[file] : undefined;
    if (!finiteMs(ms)) continue;
    total += ms;
    known = true;
  }
  return known ? total : undefined;
}
