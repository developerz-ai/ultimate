#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that the root README's code sample IS the file it
// quotes. A hand-written sample is the first code a stranger reads and the first to rot: the one this
// replaced named fields no action takes. A `<!-- readme-sample: <path> -->` marker binds the fence
// under it to a real file; `--write` rewrites the fence from the file.
//
//   bun run scripts/readme-sample.ts [--json] [--write]

// why: Bun exposes no path-join primitive; Bun.file takes one already joined.
import { join } from 'node:path';
import { flagBool, parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const README_FILE = 'README.md';
export const SAMPLE_MARKER = 'readme-sample';
export const WRITE_COMMAND = 'bun run scripts/readme-sample.ts --write';

const MARKER = /^<!--\s*readme-sample:\s*(\S+)\s*-->\s*$/;
const OPEN = /^```[A-Za-z0-9+#-]*\s*$/;
const CLOSE = /^```\s*$/;

/** One marker, and the fence under it — `start`/`end` are the fence's own lines, 0-based. */
export interface Sample {
  readonly file: string;
  readonly markerLine: number;
  readonly code: readonly string[] | undefined;
  readonly start: number;
  readonly end: number;
}

/**
 * What a README quotes of a file: everything below its leading `//` header. The header states the
 * file's responsibility to a reader of the repository; quoted on the front page it is noise, and
 * quoting from the first statement keeps the sample short without hand-trimming it.
 */
export function sampleBody(source: string): readonly string[] {
  const lines = source.split('\n');
  let from = 0;
  while (from < lines.length && /^\s*(\/\/.*)?$/.test(lines[from] ?? '')) from += 1;
  let to = lines.length;
  while (to > from && (lines[to - 1] ?? '').trim() === '') to -= 1;
  return lines.slice(from, to);
}

/** Every marker, in order. A marker binds the fence on the very next line, and nothing else. */
export function readSamples(markdown: string): readonly Sample[] {
  const lines = markdown.split('\n');
  const samples: Sample[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const marked = MARKER.exec(lines[index] ?? '');
    if (marked === null) continue;
    const file = marked[1] ?? '';
    const start = index + 1;
    if (!OPEN.test(lines[start] ?? '')) {
      samples.push({ file, markerLine: index, code: undefined, start, end: start });
      continue;
    }
    let end = start + 1;
    while (end < lines.length && !CLOSE.test(lines[end] ?? '')) end += 1;
    samples.push({ file, markerLine: index, code: lines.slice(start + 1, end), start, end });
  }
  return samples;
}

/** `unmarked` is the vacuous green: a README with no marker would make this rule check nothing. */
export type SampleGapKind = 'drift' | 'missing' | 'unfenced' | 'unmarked';

export interface SampleGap {
  readonly kind: SampleGapKind;
  readonly file: string;
  /** 1-based README line of the marker. */
  readonly line: number;
}

export type ReadFile = (path: string) => string | undefined;

/** Pure over the markdown and a reader, so every negative case is a fixture. */
export function checkSamples(markdown: string, read: ReadFile): readonly SampleGap[] {
  const samples = readSamples(markdown);
  if (samples.length === 0) return [{ kind: 'unmarked', file: '', line: 0 }];
  const gaps: SampleGap[] = [];
  for (const sample of samples) {
    const line = sample.markerLine + 1;
    if (sample.code === undefined) {
      gaps.push({ kind: 'unfenced', file: sample.file, line });
      continue;
    }
    const source = read(sample.file);
    if (source === undefined) {
      gaps.push({ kind: 'missing', file: sample.file, line });
      continue;
    }
    if (sample.code.join('\n') !== sampleBody(source).join('\n')) {
      gaps.push({ kind: 'drift', file: sample.file, line });
    }
  }
  return gaps;
}

/** Each bound fence replaced by its file's body; a fence whose file is gone is left as it was. */
export function writeSamples(markdown: string, read: ReadFile): string {
  const lines = markdown.split('\n');
  for (const sample of [...readSamples(markdown)].reverse()) {
    const source = read(sample.file);
    if (sample.code === undefined || source === undefined) continue;
    lines.splice(sample.start + 1, sample.end - sample.start - 1, ...sampleBody(source));
  }
  return lines.join('\n');
}

const FINDINGS = {
  drift: (gap) => ({
    code: 'X_README_SAMPLE_DRIFT',
    cause: `${README_FILE}:${gap.line} quotes ${gap.file}, and the fence under it is not that file's code any more`,
    fix: WRITE_COMMAND,
    at: `${README_FILE}:${gap.line}`,
  }),
  missing: (gap) => ({
    code: 'X_README_SAMPLE_DRIFT',
    cause: `${README_FILE}:${gap.line} quotes ${gap.file}, which does not exist`,
    fix: `grep -n readme-sample README.md   # point that marker at a file that exists under examples/dummy`,
    at: `${README_FILE}:${gap.line}`,
  }),
  unfenced: (gap) => ({
    code: 'X_README_SAMPLE_DRIFT',
    cause: `${README_FILE}:${gap.line} names ${gap.file} as a sample, with no code fence on the next line`,
    fix: `grep -n readme-sample README.md   # put a fence directly under that marker, then: ${WRITE_COMMAND}`,
    at: `${README_FILE}:${gap.line}`,
  }),
  unmarked: () => ({
    code: 'X_README_SAMPLE_DRIFT',
    cause: `${README_FILE} carries no readme-sample marker, so its code sample is hand-written and checked by nothing`,
    fix: "grep -n '^```' README.md   # put <!-- readme-sample: examples/dummy/apps/web/app/runs/actions/cancel-run.ts --> above the sample fence, then: bun run scripts/readme-sample.ts --write",
    at: README_FILE,
  }),
} satisfies Readonly<Record<SampleGapKind, (gap: SampleGap) => Finding>>;

/** A `switch`, not `FINDINGS[gap.kind]`: a computed read of a Record trips `proto-index`. */
export const sampleFindingFor = (gap: SampleGap): Finding => {
  switch (gap.kind) {
    case 'drift':
      return FINDINGS.drift(gap);
    case 'missing':
      return FINDINGS.missing(gap);
    case 'unfenced':
      return FINDINGS.unfenced(gap);
    case 'unmarked':
      return FINDINGS.unmarked();
  }
};

/** Every file the markers name, read once — so the check above stays pure and synchronous. */
async function readerAt(root: string, markdown: string): Promise<ReadFile> {
  const read = new Map<string, string>();
  for (const sample of readSamples(markdown)) {
    const file = Bun.file(join(root, sample.file));
    if (await file.exists()) read.set(sample.file, await file.text());
  }
  return (path) => read.get(path);
}

/** A root with no README makes no sample claim — a fixture tree, never this repository's. */
export async function readmeSampleFindings(root: string): Promise<readonly Finding[]> {
  const readme = Bun.file(join(root, README_FILE));
  if (!(await readme.exists())) return [];
  const markdown = await readme.text();
  return checkSamples(markdown, await readerAt(root, markdown)).map(sampleFindingFor);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  if (flagBool(args, 'write')) {
    const path = join(root, README_FILE);
    const markdown = await Bun.file(path).text();
    await Bun.write(path, writeSamples(markdown, await readerAt(root, markdown)));
  }
  const findings = await readmeSampleFindings(root);
  report(
    {
      ok: findings.length === 0,
      script: 'readme-sample',
      summary:
        findings.length === 0
          ? `${README_FILE}'s code sample is the file it quotes`
          : `${findings.length} README sample(s) differ from their file`,
      findings,
    },
    args.json,
  );
}
