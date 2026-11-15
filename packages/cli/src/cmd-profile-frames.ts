// `x profile`'s reading of a JavaScriptCore sampling profile: which functions the samples landed
// in (self), and which were on the stack when they did (inclusive). Grouped per function — a line
// is where one sample landed, a function is what an author can go and change.

import type { SamplingProfileStackFrame, SamplingProfileStackTraces } from 'bun:jsc';

export interface HotFrame {
  readonly name: string;
  /** Root-relative when the file is the app's; `native` for a frame with no source. */
  readonly file: string;
  /** The line most of this function's self samples landed on; null when unknown. */
  readonly line: number | null;
  /** Samples whose innermost frame was this function. */
  readonly self: number;
  /** Samples with this function anywhere on the stack, each sample counted once. */
  readonly total: number;
  /** `self` over every sample, as a whole-number percent — never a float a script compares. */
  readonly selfPercent: number;
}

export interface ProfileSummary {
  readonly samples: number;
  readonly intervalMicros: number;
  readonly hottest: readonly HotFrame[];
}

const UNKNOWN_LINE = 4_294_967_295;

const fileOf = (frame: SamplingProfileStackFrame, root: string): string => {
  const url = frame.sourceURL;
  if (url === undefined || url === '') return 'native';
  return url.startsWith(`${root}/`) ? url.slice(root.length + 1) : url;
};

const keyOf = (frame: SamplingProfileStackFrame): string =>
  `${frame.name}\u0000${frame.sourceURL ?? ''}`;

interface Tally {
  frame: SamplingProfileStackFrame;
  self: number;
  total: number;
  lines: Map<number, number>;
}

const tallyFor = (tallies: Map<string, Tally>, frame: SamplingProfileStackFrame): Tally => {
  const key = keyOf(frame);
  const found = tallies.get(key);
  if (found !== undefined) return found;
  const fresh: Tally = { frame, self: 0, total: 0, lines: new Map() };
  tallies.set(key, fresh);
  return fresh;
};

const mostSampledLine = (lines: ReadonlyMap<number, number>): number | null => {
  let best: [number, number] | undefined;
  for (const entry of lines) if (best === undefined || entry[1] > best[1]) best = entry;
  return best === undefined || best[0] === UNKNOWN_LINE ? null : best[0];
};

/** The `limit` hottest functions by self samples; ties broken by total, then name. */
export function hottestFrames(
  traces: SamplingProfileStackTraces,
  root: string,
  limit: number,
): ProfileSummary {
  const tallies = new Map<string, Tally>();
  for (const trace of traces.traces) {
    const [innermost] = trace.frames;
    if (innermost === undefined) continue;
    const top = tallyFor(tallies, innermost);
    top.self += 1;
    top.lines.set(innermost.line, (top.lines.get(innermost.line) ?? 0) + 1);
    const seen = new Set<string>();
    for (const frame of trace.frames) {
      const key = keyOf(frame);
      if (seen.has(key)) continue; // recursion: one sample is one sample
      seen.add(key);
      tallyFor(tallies, frame).total += 1;
    }
  }
  const samples = traces.traces.length;
  const hottest = [...tallies.values()]
    .filter((tally) => tally.self > 0)
    .sort(
      (a, b) => b.self - a.self || b.total - a.total || a.frame.name.localeCompare(b.frame.name),
    )
    .slice(0, limit)
    .map(
      (tally): HotFrame => ({
        name: tally.frame.name === '' ? '(anonymous)' : tally.frame.name,
        file: fileOf(tally.frame, root),
        line: mostSampledLine(tally.lines),
        self: tally.self,
        total: tally.total,
        selfPercent: samples === 0 ? 0 : Math.round((tally.self * 100) / samples),
      }),
    );
  return { samples, intervalMicros: Math.round(traces.interval * 1_000_000), hottest };
}
