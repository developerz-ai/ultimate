// A GitHub Actions log, read back into the findings that produced it. `gh run view --log-failed`
// prints `<job>\t<step>\t<timestamp> <text>` with a BOM, ANSI colour and `##[group]` markers in
// it — and underneath all of that, for a `verify` job, is `renderFinding`'s own three lines. So
// this file undoes the transport and reconstructs the `Finding`, rather than printing a wall of
// text and asking the reader to spot the code in it.

import type { Finding } from './output';

/** One log line, with the two columns Actions prefixes every line with taken off. */
export interface CiLogLine {
  readonly job: string;
  readonly step: string;
  readonly text: string;
}

// The one place the log's own transport bytes are undone, so the escape is the subject here.
//
// CSI ONLY — `ESC [ … <letter>`. It does not match OSC (`ESC ] 0 ; … BEL`, the window title), a
// bare `ESC c` (full reset) or DCS, and it is deliberately not widened: its job is undoing the
// COLOUR a runner writes, and colour is CSI. What the narrow rule costs is bounded in both
// places this feeds:
//   · `tailOf` → `x ci`'s `lines` → `renderHuman`, which runs `singleLine` over every line, so a
//     leftover OSC prints as the text `\u001b]0;…` and retitles nothing. That renderer was
//     emitting `lines` VERBATIM until 2026-08-22, and until then this regex was the only thing
//     between a CI log and the terminal — which is the reason the escape belongs there and not here.
//   · `findingsFrom` → `renderFinding`, `singleLine` again, and `--json` escapes C0 on its own.
// The residue that is not cosmetic: an escape left at the HEAD of a line stops `CODE` matching, so
// a finding written under an OSC would be read as prose and dropped rather than reconstructed.
// biome-ignore lint/suspicious/noControlCharactersInRegex: an ANSI escape IS a control character.
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;
const STAMP = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s?/;
/** Actions writes a BOM at the head of each job's first line, after the two columns. */
const BOM = /\ufeff/g;

/**
 * The two tab-separated columns are the job and the step, and the timestamp that follows is the
 * runner's. A line with neither is kept whole and attributed to no job: a log that changed shape
 * must still be readable as text, because the tail is the last thing a reader has when nothing
 * reconstructed.
 */
export function parseLogLines(log: string): readonly CiLogLine[] {
  const out: CiLogLine[] = [];
  for (const raw of log.split('\n')) {
    const line = raw.replace(BOM, '').replace(ANSI, '').trimEnd();
    if (line.trim() === '') continue;
    const columns = line.split('\t');
    const tabbed = columns.length >= 3;
    const rest = tabbed ? columns.slice(2).join('\t') : line;
    const text = rest.replace(STAMP, '').replace(/^##\[group\]/, '');
    if (text.startsWith('##[endgroup]')) continue;
    out.push({
      job: tabbed ? (columns[0] ?? '') : '',
      step: tabbed ? (columns[1] ?? '') : '',
      text,
    });
  }
  return out;
}

/** Every job the log carries a line for, in the order they first appear. */
export function jobsInLog(lines: readonly CiLogLine[]): readonly string[] {
  const seen: string[] = [];
  for (const line of lines) {
    if (line.job !== '' && !seen.includes(line.job)) seen.push(line.job);
  }
  return seen;
}

const CODE = /^(X_[A-Z][A-Z0-9_]*)/;
// The ONE way a `Finding.at` — a path an agent can open — returns from a log. The renderer
// prints it as the parenthesised expression in the head (`renderFinding`, `output.ts`).
//
// Anchored to the head minus a trailing `[step=…]`, NOT to the end of the line:
// `X_VERIFY_STEP_TIMEOUT` sets both `at` and `meta.step`, so that head reads
// `CODE (path) [step=unit]` — an end-anchor matches only what follows the brackets, the match
// fails, and the path is dropped. With no step the optional group is absent and the
// parenthesised group is still the last thing on the line.
const LOCATOR = /\(([^()]+)\)(?=\s*(?:\[step=[^[\]]+\]\s*)?$)/;
// The second, non-path locator the renderer prints on the head — `meta.step` in the same
// brackets-keyed form (`[step=lint]`) `renderFinding` writes — so a merge gap's gate step name
// or any future non-path identifier survives the round-trip too. Its own brackets are what
// `LOCATOR`'s lookahead stands aside for, so the two cannot collide in one head.
const STEP_LOCATOR = /\[step=([^\[\]]+)\]\s*$/;

const after = (text: string, label: string): string | undefined =>
  text.trim().startsWith(label) ? text.trim().slice(label.length).trim() : undefined;

/**
 * `renderFinding`'s output, read backwards. A code line ALONE is not a finding — prose naming a
 * code, a summary counting them and a `fix:` quoting one all start with `X_`, and reconstructing
 * a finding from any of those would hand the reader a cause the gate never printed. The rule is
 * the whole block: a code, then `cause:`, then `fix:`, adjacent and in that order.
 */
export function findingsFrom(lines: readonly CiLogLine[]): readonly Finding[] {
  const out: Finding[] = [];
  const seen = new Set<string>();
  // Trimmed, because `renderFinding` INDENTS: a finding under a verify step arrives with six
  // leading spaces, one printed at the command level with two, and a rule anchored to column zero
  // would find neither.
  const texts = lines.map((entry) => entry.text.trim());
  for (let index = 0; index < texts.length; index += 1) {
    const head = CODE.exec(texts[index] ?? '');
    if (head === null) continue;
    const cause = after(texts[index + 1] ?? '', 'cause:');
    const fix = after(texts[index + 2] ?? '', 'fix:');
    if (cause === undefined || fix === undefined) continue;
    const code = head[1] ?? '';
    const at = LOCATOR.exec(texts[index] ?? '')?.[1];
    const step = STEP_LOCATOR.exec(texts[index] ?? '')?.[1];
    const docs = after(texts[index + 3] ?? '', 'docs:');
    // Step name and any other reconstructed structured fact ride on `meta`, so the
    // reconstructed finding has a place to put a non-path locator `at` cannot carry.
    const meta = step === undefined ? undefined : { step };
    const key = `${code}\0${cause}\0${at ?? ''}\0${step ?? ''}`;
    // A re-run appends a second copy of the same block; two identical findings would read as two
    // problems where the job has one. The dedupe key now also keys on `at` and `step` so two
    // findings with the same code and cause but different locators stay distinct — a budget
    // finding routed to two different routes is TWO findings.
    if (!seen.has(key)) {
      seen.add(key);
      out.push({
        code,
        cause,
        fix,
        ...(at === undefined ? {} : { at }),
        ...(meta === undefined ? {} : { meta }),
        ...(docs === undefined ? {} : { docs }),
      });
    }
    index += 2;
  }
  return out;
}

/**
 * The end of a job's log. The tail is what a reader falls back on when nothing reconstructed — a
 * compile error, a container that never started — so it is the RAW text of the last lines rather
 * than a filtered view that could drop the one line that mattered.
 */
export function tailOf(lines: readonly CiLogLine[], job: string, limit: number): readonly string[] {
  const own = lines.filter((line) => line.job === job);
  // A log that attributed nothing to this job still has a tail, and it is the only evidence there
  // is — showing none of it because the columns moved would lose the whole report to a format
  // change.
  const pool = own.length > 0 ? own : lines;
  return pool.slice(-limit).map((line) => line.text);
}
