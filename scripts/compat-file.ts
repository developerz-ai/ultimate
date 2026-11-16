// A compat run's verdict per cell, filed: every cell of the matrix is judged from its parts'
// documents — a red part or a missing one makes the cell red — and each red cell files or updates
// ONE `compat` issue by its title, while a cell whose every part passed closes its own. The ledger
// is the flake hunt's (`lib/issue-ledger.ts`), so a title found again behaves the same in both.

import type { CompatCell, CompatMatrix } from './compat-cells';
import type { PartDoc } from './compat-part';
import type { Gh, IssuePlan, Ledger } from './lib/issue-ledger';
import { fence, fileIssues, ledgerTitle } from './lib/issue-ledger';
import type { Finding } from './lib/log';
import { gh as ghRun } from './lib/release-due-gh';

/** The one label every compat issue carries — what `gh issue list --label` finds them by. */
export const COMPAT_LABEL = 'compat';
const EXCERPT_MAX = 4000;
/** An issue quotes a reader's worth of failing tests; the run's artifacts hold the rest. */
const FAILURES_SHOWN = 20;

const LEDGER: Ledger = {
  label: COMPAT_LABEL,
  color: 'd93f0b',
  description: 'a runtime compat.yml tests that the gate does not pin went red',
  code: 'X_COMPAT_FILE_FAILED',
  fix: 'gh auth status && bun run scripts/compat.ts file <part.json…>',
  at: 'scripts/compat-file.ts',
};

/** Stable forever: a cell's issue is found again by exactly this. */
export const titleOf = (cellId: string): string => ledgerTitle(`compat: ${cellId}`);

/** Each part's newest attempt: a re-run's document replaces the one it re-ran. */
const newest = (docs: readonly PartDoc[], cell: string): Map<string, PartDoc> => {
  const byPart = new Map<string, PartDoc>();
  for (const doc of docs) {
    if (doc.cell !== cell) continue;
    const seen = byPart.get(doc.part);
    if (seen === undefined || doc.attempt >= seen.attempt) byPart.set(doc.part, doc);
  }
  return byPart;
};

const redBody = (
  cell: CompatCell,
  matrix: CompatMatrix,
  byPart: ReadonlyMap<string, PartDoc>,
  runUrl: string | undefined,
): string => {
  const docs = [...byPart.values()];
  const lines = [
    `\`compat.yml\` ran the gate's \`unit\` and \`live\` on **${cell.id}** (${cell.axis} ${cell.version}) and it went red${runUrl === undefined ? '' : ` in ${runUrl}`}.`,
    '',
    `Bun: ${[...new Set(docs.map((doc) => doc.bun))].join(', ') || 'no part reported one'}`,
    '',
    '| part | verdict | failing tests |',
    '|---|---|---|',
    ...matrix.parts.map((part) => {
      const doc = byPart.get(part.name);
      if (doc === undefined) return `| ${part.name} | no document | – |`;
      return `| ${part.name} | ${doc.ok ? 'green' : 'red'} | ${doc.failures.length} |`;
    }),
  ];
  const missing = matrix.parts.filter((part) => !byPart.has(part.name));
  if (missing.length > 0) {
    lines.push(
      '',
      'A part with no document died before the gate ran — its install, its services or its Bun: read that job’s log in the run.',
    );
  }
  const failures = docs.flatMap((doc) => doc.failures.map((failure) => ({ doc, failure })));
  if (failures.length > 0) {
    lines.push('', 'Failing tests:', '');
    for (const { failure } of failures.slice(0, FAILURES_SHOWN)) {
      lines.push(`- \`${`${failure.file} > ${failure.test}`.replaceAll('`', "'")}\``);
    }
  }
  const red = docs.filter((doc) => !doc.ok);
  if (red.length > 0) {
    lines.push(
      '',
      'Replay each red part on the cell’s runtime:',
      fence('sh', red.map((doc) => doc.rerun).join('\n')),
    );
  }
  const excerpt = failures[0]?.failure.excerpt ?? red[0]?.tail ?? '';
  if (excerpt !== '')
    lines.push('', 'What Bun printed:', fence('text', excerpt.slice(-EXCERPT_MAX)));
  return lines.join('\n');
};

/** The issues a run calls for: one per red cell, and a closing note per green one. */
export function judgeCells(
  matrix: CompatMatrix,
  docs: readonly PartDoc[],
  runUrl: string | undefined,
): { readonly red: readonly IssuePlan[]; readonly green: readonly IssuePlan[] } {
  const red: IssuePlan[] = [];
  const green: IssuePlan[] = [];
  for (const cell of matrix.cells) {
    const byPart = newest(docs, cell.id);
    const passed = matrix.parts.every((part) => byPart.get(part.name)?.ok === true);
    if (passed) {
      const on = [...new Set([...byPart.values()].map((doc) => doc.bun))].join(', ');
      green.push({
        title: titleOf(cell.id),
        body: `Every part of **${cell.id}** passed${runUrl === undefined ? '' : ` in ${runUrl}`} (Bun ${on}): closed by its own green run.`,
      });
    } else {
      red.push({ title: titleOf(cell.id), body: redBody(cell, matrix, byPart, runUrl) });
    }
  }
  return { red, green };
}

export async function fileCompat(
  matrix: CompatMatrix,
  docs: readonly PartDoc[],
  root: string,
  runUrl: string | undefined,
  gh: Gh = ghRun,
): Promise<{
  readonly red: readonly string[];
  readonly filed: readonly string[];
  readonly findings: readonly Finding[];
}> {
  const { red, green } = judgeCells(matrix, docs, runUrl);
  const { filed, findings } = await fileIssues(red, root, LEDGER, gh, green);
  const redIds = matrix.cells.filter((cell) => red.some((plan) => plan.title === titleOf(cell.id)));
  return { red: redIds.map((cell) => cell.id), filed, findings };
}
