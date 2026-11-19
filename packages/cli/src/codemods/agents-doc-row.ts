// One row of an app's agent brief, changed by a codemod: found in CLAUDE.md or AGENTS.md, held to
// the byte budget the manifest step enforces, and reported as a skip with the row itself whenever
// it cannot be placed. A silent `changed: []` left the row owed with nobody told.

import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
import { parseVerifyFloor, VERIFY_FLOOR_FILE } from '../verify-floor';
import type { CodemodApp, CodemodResult } from './codemod';
import { readText } from './engine-edits';

/** Where an app keeps its brief: the scaffold writes CLAUDE.md, and some apps moved it. */
const BRIEFS = ['CLAUDE.md', 'AGENTS.md'] as const;

export interface AgentsDocRow {
  /** The text the row is placed against, and what it becomes: an insert or a swap. */
  readonly from: string;
  readonly to: string;
  /** The row a person adds when it cannot be placed. */
  readonly row: string;
  /** Already said, in the app's own words or the template's: nothing to do. */
  readonly said: (text: string) => boolean;
  /** Why `from` is missing, in the skip a person reads. */
  readonly missing: string;
}

/** `x.verify.json`'s `agentsMdMaxBytes`, else the manifest's default: the one the gate holds. */
async function budgetOf(app: CodemodApp): Promise<number> {
  const floor = await app.read(VERIFY_FLOOR_FILE);
  if (floor === undefined) return AGENTS_MD_MAX_BYTES;
  try {
    return parseVerifyFloor(floor).agentsMdMaxBytes ?? AGENTS_MD_MAX_BYTES;
  } catch {
    // An unreadable floor is the gate's own finding (`floorProblemFindings`); the default stands.
    return AGENTS_MD_MAX_BYTES;
  }
}

const skip = (path: string, reason: string): CodemodResult => ({
  changed: [],
  skipped: [{ path, reason }],
});

export async function editAgentsDocRow(
  app: CodemodApp,
  edit: AgentsDocRow,
): Promise<CodemodResult> {
  const briefs: { path: string; text: string; restore: (text: string) => string }[] = [];
  for (const path of BRIEFS) {
    const file = await readText(app, path);
    if (file !== undefined) briefs.push({ path, ...file });
  }
  if (briefs.length === 0 || briefs.some((brief) => edit.said(brief.text))) {
    return { changed: [], skipped: [] };
  }
  const target = briefs.find((brief) => brief.text.split(edit.from).length === 2);
  if (target === undefined) {
    const path = briefs[0]?.path ?? BRIEFS[0];
    return skip(
      path,
      `${edit.missing}; add this row to the conventions table by hand: ${edit.row}`,
    );
  }
  const next = target.text.replace(edit.from, () => edit.to);
  const bytes = Buffer.byteLength(target.restore(next), 'utf8');
  const budget = await budgetOf(app);
  if (bytes > budget) {
    return skip(
      target.path,
      `the row would take ${target.path} to ${String(bytes)} bytes, over its ${String(budget)}-byte budget (${VERIFY_FLOOR_FILE} agentsMdMaxBytes); make room, then add this row by hand: ${edit.row}`,
    );
  }
  await app.write(target.path, target.restore(next));
  return { changed: [target.path], skipped: [] };
}
