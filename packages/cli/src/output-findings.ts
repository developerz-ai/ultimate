// What a reader is owed beyond a finding as it was thrown: a fix that runs where `x` is not on
// PATH, and one line for one cause. Render layer only, so every throw site keeps spelling `x …`,
// which is what `fix-command.ts` reads to prove the command exists.

import type { Finding, JsonValue } from './output';

const SEGMENT_END = /^(?:&&|\|\||;)/;
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=(?:'[^']*'|"[^"]*"|[^\s'"]*)\s+/;

/** Where the command word of a segment starts, past its `A=b` prefix. */
const commandWordAt = (fix: string, from: number): number => {
  let at = from;
  for (;;) {
    while (fix[at] === ' ') at += 1;
    const assignment = ENV_ASSIGNMENT.exec(fix.slice(at));
    if (assignment === null) return at;
    at += assignment[0].length;
  }
};

const isBareX = (fix: string, at: number): boolean =>
  fix[at] === 'x' && (at + 1 === fix.length || fix[at + 1] === ' ');

/** What may stand before a quote that opens one: after a letter or a `"` it is an apostrophe. */
const BEFORE_QUOTE = /[\s([{=,:]/;
/** What may stand before a cited `x`: `apps/web/x.ts` and `max y` cite nothing. */
const BEFORE_CITATION = /[\s(`]/;
/** A runner already in front of this `x`. `then run x verify` has none: `run` alone is prose. */
const RUNNER_BEFORE = /(?:^|\s)(?:bunx|npx|bun|bun run|--bun)\s+$/;

const opensQuote = (fix: string, at: number): boolean =>
  (fix[at] === "'" || fix[at] === '"') && (at === 0 || BEFORE_QUOTE.test(fix[at - 1] ?? ''));

/** `x <command>` anywhere in the line: a `then: x verify` tail is followed as literally as a head. */
const citesX = (fix: string, at: number): boolean =>
  fix[at] === 'x' &&
  fix[at + 1] === ' ' &&
  /[a-z<]/.test(fix[at + 2] ?? '') &&
  (at === 0 || BEFORE_CITATION.test(fix[at - 1] ?? '')) &&
  !RUNNER_BEFORE.test(fix.slice(0, at));

/**
 * Every `x` the line tells its reader to run becomes `bunx x`: the head of each `&&`, `||` and `;`
 * segment, and a citation anywhere after it, a `#` or `//` tail included, because a reader follows
 * `# then: x verify` too. A quoted span is an argument and is copied. `bunx x` itself does not
 * match, so a report read back by `x verify merge` and rendered again does not grow.
 */
export function runnableFix(fix: string): string {
  let out = '';
  let at = 0;
  let segmentStart = true;
  while (at < fix.length) {
    if (segmentStart) {
      const word = commandWordAt(fix, at);
      out += fix.slice(at, word);
      at = word;
      segmentStart = false;
      if (isBareX(fix, at)) {
        out += 'bunx x';
        at += 1;
      }
      continue;
    }
    const close = opensQuote(fix, at) ? fix.indexOf(fix[at] ?? '', at + 1) : -1;
    if (close !== -1) {
      out += fix.slice(at, close + 1);
      at = close + 1;
      continue;
    }
    const end = SEGMENT_END.exec(fix.slice(at));
    if (end !== null) {
      out += end[0];
      at += end[0].length;
      segmentStart = true;
      continue;
    }
    if (citesX(fix, at)) {
      out += 'bunx x';
      at += 1;
      continue;
    }
    out += fix[at] ?? '';
    at += 1;
  }
  return out;
}

const keyOf = (finding: Finding): string =>
  [finding.code, finding.cause, finding.fix].join('\u0000');

/**
 * One finding per code + cause + fix, with how many reported it and where. A broken `$view` throws
 * from every module importing its entity: 3 findings on one load, 29 on a larger app, one repair.
 * The fix is in the key because a rule whose cause is generic names the file in its fix, and those
 * are separate repairs. `reportedAt` keeps what `at` can no longer say.
 */
export function collapseFindings(findings: readonly Finding[]): readonly Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const finding of findings) {
    const key = keyOf(finding);
    const group = groups.get(key);
    if (group === undefined) groups.set(key, [finding]);
    else group.push(finding);
  }
  return [...groups.values()].map((group) => {
    const first = group[0] as Finding;
    if (group.length === 1) return first;
    const reportedAt = group.flatMap((one) => (one.at === undefined ? [] : [one.at]));
    const meta: { [key: string]: JsonValue } = { ...first.meta, count: group.length };
    if (reportedAt.length > 0) meta['reportedAt'] = reportedAt;
    return { ...first, meta };
  });
}

/** How many sites the human line names. `--json` carries all of them in `meta.reportedAt`. */
const SITES_SHOWN = 3;

/** The human half of a count: `meta` is never the only home of a fact. */
export function causeWithCount(finding: Finding): string {
  const count = finding.meta?.['count'];
  if (typeof count !== 'number') return finding.cause;
  const sites = finding.meta?.['reportedAt'];
  const named = Array.isArray(sites) ? sites.slice(0, SITES_SHOWN).join(', ') : '';
  return `${finding.cause} (reported ${String(count)} times${named === '' ? '' : `: ${named}`})`;
}

export interface ReaderOptions {
  /** `x` is not this reader's command: its fixes name `bunx x`. `dispatch` decides. */
  readonly bunxRunner?: boolean;
}

/** One fix line outside a finding: a pointer on stderr, or `x errors explain`'s answer. */
export const fixForReader = (fix: string, reader: ReaderOptions = {}): string =>
  reader.bunxRunner === true ? runnableFix(fix) : fix;

/** A finding read out of a CI log is fenced text and is never turned into an instruction. */
const withRunnableFix = (finding: Finding): Finding => {
  if (finding.source === 'ci-log') return finding;
  const fix = runnableFix(finding.fix);
  return fix === finding.fix ? finding : { ...finding, fix };
};

/** The list a renderer prints. */
export const findingsForReader = (
  findings: readonly Finding[],
  options: ReaderOptions,
): readonly Finding[] => {
  const collapsed = collapseFindings(findings);
  return options.bunxRunner === true ? collapsed.map(withRunnableFix) : collapsed;
};
