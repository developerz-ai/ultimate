#!/usr/bin/env bun
// Enforce, as a gate step, that a command a doc page hands a reader is a command this build ships.
// The `errors` step resolves `x <command>` citations in shipped SOURCE and nothing resolved them
// in prose — so `x live explain`, `x db query`, `x db drift`, `x jobs run` and `x env check --fix`
// all sat in `wiki/` and `docs/` as instructions an agent runs once and gets X_CLI_UNKNOWN_COMMAND
// or X_CLI_BAD_FLAG from. Same resolver as the source rule (`@ultimat3/cli`'s `citationFault`),
// pointed at a second file set — a second resolver is the drift this repo forbids by name.
//
// Runs on `x verify`'s `manifest` step: does a committed file still describe this tree?
//
//   bun run scripts/doc-commands.ts [--json]

import type { CommandCatalog } from '@ultimat3/cli';
import { citationFault, loadCommandCatalog } from '@ultimat3/cli';
import type { DocCommandAllowance } from './doc-commands-allow';
import { DOC_COMMAND_ALLOWANCES } from './doc-commands-allow';
import { parseScriptArgs } from './lib/args';
import type { DocCitation, MarkdownFile } from './lib/doc-citations';
import { readMarkdown, scanDocCitations } from './lib/doc-citations';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

/**
 * Every page that hands a reader a command, not just the two doc trees. It was `wiki/` + `docs/`
 * alone, so `README.md`, `CLAUDE.md`, `AGENTS.md`, `PUBLISHING.md` and all 30 package READMEs went
 * unchecked — which is how the README's `x g` kind list stayed four kinds short of the registry.
 * The same set `scripts/version-stamps.ts` already reads, for the same reason: an agent does not
 * know which directory a page lives in before it runs what the page told it to.
 */
export const DOC_GLOBS: readonly string[] = [
  '*.md',
  'wiki/**/*.md',
  'docs/**/*.md',
  'packages/*/*.md',
];
export const ALLOW_FILE = 'scripts/doc-commands-allow.ts';
/** Where `DOC_COMMAND_PINS` lives — the file a pin finding tells its reader to edit. */
export const PINS_FILE = 'scripts/doc-commands.ts';

/**
 * Two pages this rule does not read, for two different reasons.
 *
 * `docs/plans/` is a dated record of work, not an instruction to a reader — and the audit that
 * produced this check quotes every broken command it found as evidence. A rule that failed on a bug
 * report is a rule that makes bug reports unwritable.
 *
 * `wiki/Error-Codes.md` belongs to `scripts/doc-fixes.ts`, which holds its `Fix` column to a
 * STRICTER rule than this one: a fix may not cite a planned command, and a doc sentence may. Two
 * reporters of one condition is the duplication this repo forbids by name, so the error reference
 * has exactly one owner.
 */
export const skipDocPath = (path: string): boolean =>
  path.startsWith('docs/plans/') || path === 'CHANGELOG.md' || path === 'wiki/Error-Codes.md';

/**
 * A per-file count of citations that do not resolve, tolerated because they were already there
 * when this rule learned to read the file. It may SHRINK and never grow — the ratchet
 * `scripts/test-bare-error.ts` runs, for the reason it gives: 23 sites across seven packages were
 * sitting under a green gate, and refusing to widen the rule until every one is fixed is how a
 * rule stays narrow forever.
 *
 * An entry is a COUNT, not a verdict. Most of `packages/cli/CLAUDE.md`'s are deliberate — that file
 * documents this checker's own findings and has to quote the commands that do not exist — and a
 * deliberate citation belongs in `DOC_COMMAND_ALLOWANCES`, which records WHY. Moving one there
 * lowers the number here; fixing a genuinely wrong line lowers it too. Both are progress.
 */
export const DOC_COMMAND_PINS: Readonly<Record<string, number>> = {
  'packages/action/README.md': 2,
  'packages/admin/CLAUDE.md': 1,
  'packages/admin/README.md': 1,
  'packages/cli/CLAUDE.md': 12,
  'packages/db/CLAUDE.md': 1,
  'packages/db/README.md': 1,
  'packages/entity/CLAUDE.md': 1,
  'packages/flags/CLAUDE.md': 1,
  'packages/flags/README.md': 1,
  'packages/mail/README.md': 1,
};

/**
 * `unresolved` is the hazard. `allowance` is the list's own hygiene — an entry matching nothing is
 * a waiver nobody reads, and the page it named may have been fixed or deleted. `vacuous` is the
 * false green: a glob that matches no file answers "every citation resolved" over nothing.
 *
 * `pin` and `pin-exceeded` are the two DIRECTIONS a pin can be wrong in, and they are separate
 * kinds because the edit they ask for is opposite. They were one kind under a ternary whose two
 * branches were character-for-character identical, so a file that had GROWN past its pin was
 * handed `set DOC_COMMAND_PINS[…] to <the bigger number>` — a ratchet printing the instruction for
 * raising itself, which is the one thing `scripts/lib/unpin.ts` exists to stop elsewhere.
 */
export type DocCommandGapKind = 'unresolved' | 'allowance' | 'vacuous' | 'pin' | 'pin-exceeded';

export interface DocCommandGap {
  readonly kind: DocCommandGapKind;
  readonly at: string;
  /** The invocation, spelled as it would be typed. Empty for `vacuous`. */
  readonly subject: string;
  readonly detail: string;
}

export interface DocCommandInput {
  readonly files: readonly MarkdownFile[];
  readonly catalog: CommandCatalog;
  readonly allow: readonly DocCommandAllowance[];
  /** Path → how many unresolved citations that file may still hold. See `DOC_COMMAND_PINS`. */
  readonly pins: Readonly<Record<string, number>>;
}

const allows = (allowance: DocCommandAllowance, path: string, subject: string): boolean =>
  allowance.path === path && allowance.cites === subject;

/**
 * Pure, so the negative case is a fixture rather than an edit to a page three other people are
 * rewriting. `allowPlanned` is on: the nine `PLANNED_COMMANDS` and `x db studio` are in the
 * registry, `x help` lists them, and `wiki/CLI-Reference.md` has a table whose whole job is to name
 * them. A `fix:` may not cite one; a sentence may.
 */
export function checkDocCommands(input: DocCommandInput): readonly DocCommandGap[] {
  if (input.files.length === 0) {
    return [
      {
        kind: 'vacuous',
        at: DOC_GLOBS.join(', '),
        subject: '',
        detail: 'no markdown file matched',
      },
    ];
  }
  const gaps: DocCommandGap[] = [];
  const used = new Set<DocCommandAllowance>();
  /** How many unresolved citations each pinned file actually holds, so the pin can be compared. */
  const counted = new Map<string, number>();
  // One finding per line per invocation, not one per code span: a table row routinely writes
  // `x env check --fix` twice, and two identical findings read as two defects.
  const reported = new Set<string>();
  const cited: DocCitation[] = input.files.flatMap((file) => [...scanDocCitations(file)]);
  for (const one of cited) {
    const fault = citationFault(one.citation, input.catalog, { allowPlanned: true });
    if (fault === undefined) continue;
    const allowance = input.allow.find((entry) => allows(entry, one.path, fault.subject));
    if (allowance !== undefined) {
      used.add(allowance);
      continue;
    }
    const at = `${one.path}:${one.line}`;
    if (reported.has(`${at} ${fault.subject}`)) continue;
    reported.add(`${at} ${fault.subject}`);
    const pinned = input.pins[one.path];
    if (pinned !== undefined) {
      counted.set(one.path, (counted.get(one.path) ?? 0) + 1);
      continue;
    }
    gaps.push({ kind: 'unresolved', at, subject: fault.subject, detail: fault.reason });
  }
  // A pin above what the file now holds is a waiver nobody needs: the same rule the allowance list
  // runs, one file set on. It may only come down, so a stale one is a finding rather than slack.
  for (const [path, pinned] of Object.entries(input.pins)) {
    const found = counted.get(path) ?? 0;
    if (found === pinned) continue;
    gaps.push({
      kind: found > pinned ? 'pin-exceeded' : 'pin',
      at: PINS_FILE,
      subject: path,
      detail: `${found} now, pinned at ${pinned}`,
    });
  }
  for (const allowance of input.allow) {
    if (used.has(allowance)) continue;
    gaps.push({
      kind: 'allowance',
      at: ALLOW_FILE,
      subject: allowance.cites,
      detail: allowance.path,
    });
  }
  return gaps;
}

const unresolvedFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_UNKNOWN',
  cause: `${gap.at} hands a reader "${gap.subject}", ${gap.detail}`,
  fix: `edit ${gap.at} to name an invocation this build ships — x help --json lists every command and its flags — or add { path, cites, kind, why } for it to DOC_COMMAND_ALLOWANCES in ${ALLOW_FILE} if the sentence is about the command NOT existing`,
  at: gap.at,
});

const allowanceFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_ALLOWANCE_STALE',
  cause: `${ALLOW_FILE} allows ${gap.detail} to name "${gap.subject}" and that page no longer does — a waiver nobody removes is a waiver nobody reads`,
  fix: `delete the { path: '${gap.detail}', cites: '${gap.subject}' } entry from DOC_COMMAND_ALLOWANCES in ${ALLOW_FILE}`,
  at: ALLOW_FILE,
});

const vacuousFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_UNSCANNED',
  cause: `${gap.detail} for ${gap.at}, so this rule reported green over a documentation surface it never read`,
  fix: `restore the documentation under wiki/ and docs/, or change DOC_GLOBS in scripts/doc-commands.ts to the paths this repo actually publishes`,
  at: gap.at,
});

/** The pin is ABOVE what the file holds: the file improved and the ratchet has to follow it down. */
const pinFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_PIN_STALE',
  cause: `${gap.subject} holds ${gap.detail} unresolved x citations`,
  fix: `set DOC_COMMAND_PINS['${gap.subject}'] in ${PINS_FILE} to the first number in "${gap.detail}", or delete the entry when it reaches 0`,
  at: gap.subject,
});

/**
 * The other direction, and the one the shared fix line was wrong for: the file now holds MORE than
 * its pin. Raising the number is the one edit that must not be offered, so this finding does not
 * mention it.
 */
const pinExceededFinding = (gap: DocCommandGap): Finding => ({
  code: 'X_DOC_COMMAND_PIN_EXCEEDED',
  cause: `${gap.subject} holds ${gap.detail} unresolved x citations — a pin may only come down`,
  fix: `x help --json   # then correct the citations in ${gap.subject} that name no invocation it lists, or record a deliberate one as { path, cites, kind, why } in DOC_COMMAND_ALLOWANCES in ${ALLOW_FILE}`,
  at: gap.subject,
});

const FINDINGS: Readonly<Record<DocCommandGapKind, (gap: DocCommandGap) => Finding>> = {
  unresolved: unresolvedFinding,
  allowance: allowanceFinding,
  vacuous: vacuousFinding,
  pin: pinFinding,
  'pin-exceeded': pinExceededFinding,
};

export const docCommandFindingFor = (gap: DocCommandGap): Finding => FINDINGS[gap.kind](gap);

/** Read every documentation page once, whatever the glob list. */
export const readDocPages = async (root: string): Promise<readonly MarkdownFile[]> => {
  const seen = new Map<string, MarkdownFile>();
  for (const glob of DOC_GLOBS) {
    for (const file of await readMarkdown(root, glob, skipDocPath)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : 1));
};

export const docCommandGaps = async (root: string): Promise<readonly DocCommandGap[]> =>
  checkDocCommands({
    files: await readDocPages(root),
    catalog: await loadCommandCatalog(),
    allow: DOC_COMMAND_ALLOWANCES,
    pins: DOC_COMMAND_PINS,
  });

/** What this repo contributes to `x verify`'s `manifest` step. */
export const docCommandFindings = async (root: string): Promise<readonly Finding[]> =>
  (await docCommandGaps(root)).map(docCommandFindingFor);

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const root = repoRoot();
  const files = await readDocPages(root);
  const gaps = await docCommandGaps(root);
  report(
    {
      ok: gaps.length === 0,
      script: 'doc-commands',
      summary:
        gaps.length === 0
          ? `${files.length} pages, every documented x invocation resolves against the registry (${Object.values(DOC_COMMAND_PINS).reduce((sum, n) => sum + n, 0)} pinned across ${Object.keys(DOC_COMMAND_PINS).length} package pages, which may only shrink)`
          : `${gaps.length} documented x invocation(s) this build cannot run, across ${files.length} pages`,
      findings: gaps.map(docCommandFindingFor),
    },
    args.json,
  );
}
