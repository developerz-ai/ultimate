#!/usr/bin/env bun
// The body of the one `next` tracking issue: every break parked for the major window, each cited at
// the plan and ledger lines that parked it (`scripts/lib/next-breaks-list.ts`). Refuses when a
// citation moved, a Known-Gaps row parks a break the list omits, or a source comment promises a
// removal at the next major that no row removes. Prints the body; `--json` wraps it.
//
//   bun run scripts/next-breaks.ts > body.md && gh issue create --title "$(bun run scripts/next-breaks.ts --json | jq -r .data.title)" --body-file body.md

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report, writeOut } from './lib/log';
import type { ParkedBreak, RemovedSymbol } from './lib/next-breaks-list';
import {
  KNOWN_GAPS,
  NEXT_TRACKING_TITLE,
  PARKED_BREAKS,
  PARKED_ON_NEXT,
} from './lib/next-breaks-list';
import type { TagSite } from './lib/next-breaks-tags';
import {
  declarationLine,
  scanParkedTags,
  unparkedTags,
  untaggedRemovals,
} from './lib/next-breaks-tags';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';
import { requireWorkspaceManifest } from './lib/workspaces';

const SCRIPT = 'next-breaks';
const LIST = 'scripts/lib/next-breaks-list.ts';
const BLOB = 'https://github.com/developerz-ai/ultimate/blob/main';

export interface Citation {
  readonly path: string;
  readonly line: number;
  /** A removal whose declaration carries no `@deprecated` naming the next major yet. */
  readonly tagOwed?: true;
}
export type LocatedBreak = ParkedBreak & { readonly citations: readonly Citation[] };

/** The 1-based line of the list file holding `needle`, so a fix opens at the row to edit. */
const listLine = (listText: string, needle: string): number =>
  listText.split('\n').findIndex((text) => text.includes(needle)) + 1 || 1;

const moved = (path: string, anchor: string, found: number, line: number): Finding => ({
  code: 'X_NEXT_BREAK_SOURCE_MOVED',
  cause: `${path} holds ${found} line(s) containing ${JSON.stringify(anchor)}, so the break it parked cannot be cited at one line`,
  fix: `edit ${LIST}:${line} — point this anchor at the one line of ${path} that now records the break, or drop the source if the break shipped`,
  at: path,
});

const readText = async (root: string, path: string): Promise<string | undefined> => {
  const file = Bun.file(`${root}/${path}`);
  return (await file.exists()) ? file.text() : undefined;
};

const undeclared = (path: string, symbol: string, line: number): Finding => ({
  code: 'X_NEXT_BREAK_SOURCE_MOVED',
  cause: `${path} declares no \`${symbol}\`, so the removal this break parks cannot be cited at one line`,
  fix: `edit ${LIST}:${line} — point this removal at the file that now declares ${symbol}, or drop it if the removal shipped`,
  at: path,
});

/**
 * Each break with its sources and removals resolved to `file:line`; a finding per source that is
 * not one line and per removal its file no longer declares. `tagged` are the tag sites: a removal
 * none of them names is cited `tagOwed`.
 */
export async function locateBreaks(
  root: string,
  list: readonly ParkedBreak[],
  tagged: readonly TagSite[] = [],
): Promise<{ readonly located: readonly LocatedBreak[]; readonly findings: readonly Finding[] }> {
  const findings: Finding[] = [];
  const located: LocatedBreak[] = [];
  const listText = (await readText(root, LIST)) ?? '';
  for (const parked of list) {
    const citations: Citation[] = [];
    for (const { path, anchor } of parked.sources) {
      const lines = (await readText(root, path))?.split('\n') ?? [];
      const hits = lines.flatMap((text, index) => (text.includes(anchor) ? [index + 1] : []));
      const [line] = hits;
      if (hits.length === 1 && line !== undefined) citations.push({ path, line });
      else findings.push(moved(path, anchor, hits.length, listLine(listText, anchor)));
    }
    const owed = untaggedRemovals(tagged, [parked]);
    for (const removed of parked.removes ?? []) {
      const { path, symbol } = removed;
      const line = declarationLine((await readText(root, path)) ?? '', symbol);
      if (line === undefined) {
        findings.push(undeclared(path, symbol, listLine(listText, `symbol: '${symbol}'`)));
      } else {
        citations.push({ path, line, ...(owed.includes(removed) ? { tagOwed: true } : {}) });
      }
    }
    located.push({ ...parked, citations });
  }
  return { located, findings };
}

/** Known-Gaps rows that park a fix on `next` and that no break in `list` cites. */
export function unlistedGaps(
  gaps: string,
  list: readonly ParkedBreak[],
  listText = '',
): readonly Finding[] {
  const line = listLine(listText, 'export const PARKED_BREAKS');
  const anchors = list.flatMap((parked) =>
    parked.sources.filter((source) => source.path === KNOWN_GAPS).map((source) => source.anchor),
  );
  return gaps.split('\n').flatMap((text, index) => {
    if (!text.startsWith('|') || !PARKED_ON_NEXT.test(text)) return [];
    if (anchors.some((anchor) => text.includes(anchor))) return [];
    return [
      {
        code: 'X_NEXT_BREAK_UNLISTED',
        cause: `${KNOWN_GAPS}:${index + 1} parks a break on \`next\` that the tracking issue does not list: ${text.slice(0, 120)}`,
        fix: `edit ${LIST}:${line} — add a row whose source is { path: '${KNOWN_GAPS}', anchor: <a phrase from line ${index + 1}> }`,
        at: `${KNOWN_GAPS}:${index + 1}`,
      },
    ];
  });
}

const cite = ({ path, line, tagOwed }: Citation): string =>
  `[${path}:${line}](${BLOB}/${path}#L${line})${tagOwed ? ' (`@deprecated` owed)' : ''}`;

/** The issue body: what the issue is for, then one table row per break. */
export function renderBody(located: readonly LocatedBreak[]): string {
  return [
    'Every breaking change parked for the next major. Each one ships its non-breaking half on `main` now; the break lands on `next` and reaches users when `next` merges, inside the major window ([Stability](https://github.com/developerz-ai/ultimate/wiki/Stability)).',
    '',
    '`scripts/release-due.ts` proposes that merge as one pull request once the window is open and `next` is green and ahead (`data.nextLane`); a person merges it.',
    '',
    '| Id | Break | On `next` | Parked at |',
    '|---|---|---|---|',
    ...located.map(
      (parked) =>
        `| ${parked.ids} | ${parked.title} | ${parked.change} | ${parked.citations.map(cite).join('<br>')} |`,
    ),
    '',
    'Generated by `bun run scripts/next-breaks.ts`; a new parked break is a row in `scripts/lib/next-breaks-list.ts`, then `gh issue edit <n> --body-file <(bun run scripts/next-breaks.ts)`.',
    '',
  ].join('\n');
}

export async function nextBreaks(root: string): Promise<{
  readonly title: string;
  readonly body: string;
  readonly located: readonly LocatedBreak[];
  readonly findings: readonly Finding[];
  readonly owed: readonly RemovedSymbol[];
}> {
  const tagged = await scanParkedTags(root, await currentMajor(root));
  const { located, findings } = await locateBreaks(root, PARKED_BREAKS, tagged);
  const gaps = (await readText(root, KNOWN_GAPS)) ?? '';
  const listText = (await readText(root, LIST)) ?? '';
  return {
    title: NEXT_TRACKING_TITLE,
    body: renderBody(located),
    located,
    findings: [
      ...findings,
      ...unlistedGaps(gaps, PARKED_BREAKS, listText),
      ...unparkedTags(tagged, PARKED_BREAKS, listText),
    ],
    owed: untaggedRemovals(tagged, PARKED_BREAKS),
  };
}

/** The major every workspace is stamped at, read off `@ultimat3/core` (they move in lockstep). */
async function currentMajor(root: string): Promise<number> {
  const core = 'packages/core/package.json';
  const { version } = await requireWorkspaceManifest(`${root}/${core}`, core);
  const major = Number(version?.split('.')[0]);
  if (Number.isInteger(major)) return major;
  throw new ScriptError({
    code: 'X_WORKSPACE_MANIFEST_UNREADABLE',
    cause: `${core} carries no release version, so no major is current and no comment naming one can be read as a promise`,
    fix: 'bun run scripts/list-workspaces.ts --json   # every workspace stamps one version; restore core\'s "version"',
  });
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const { title, body, located, findings, owed } = await nextBreaks(repoRoot());
  if (findings.length > 0 || args.json) {
    report(
      {
        ok: findings.length === 0,
        script: SCRIPT,
        summary:
          findings.length === 0
            ? `${located.length} parked break(s)`
            : 'refused: the parked-break list is behind its sources',
        findings,
        data: { title, body, breaks: located, owed },
      },
      args.json,
    );
  }
  writeOut(body);
}
