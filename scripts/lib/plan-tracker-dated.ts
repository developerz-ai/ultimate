// A plan tracker edited on this branch bumps its own `last_updated`. A depth-1 CI clone dates a
// tracker by that field (roadmap-stale-plans.ts), so an edit that leaves it alone turns `roadmap`
// red 30 days later with no commit to blame (review of #1161). Base text vs now, per changed file.

import { renderFixShellArg } from '@ultimat3/core';
import { textAt } from './base-ref';
import { changedSinceBase } from './changed-files';
import type { Finding } from './log';

/** One tracker this branch changed: its text at the base (absent when new) and now. */
export interface TrackerEdit {
  readonly path: string;
  readonly before: string | undefined;
  readonly after: string;
}

const TRACKER = /^docs\/plans\/.+\/status\.yml$/;

/** The `last_updated:` value as written, or `undefined` when the line is absent. */
const lastUpdated = (text: string): string | undefined =>
  /^last_updated:\s*(.+?)\s*$/m.exec(text)?.[1];

/**
 * Each tracker whose content moved while its `last_updated` stayed on a day before `today` (UTC
 * `YYYY-MM-DD`): a second edit on the day already stamped owes nothing. A new tracker owes nothing.
 */
export function undatedFindings(edits: readonly TrackerEdit[], today: string): readonly Finding[] {
  return edits
    .filter(({ before, after }) => before !== undefined && before !== after)
    .filter(({ before, after }) => lastUpdated(before ?? '') === lastUpdated(after))
    .filter(({ after }) => (lastUpdated(after) ?? '') < today)
    .map(({ path, after }) => ({
      code: 'X_PLAN_STATUS_UNDATED',
      cause: `${path} changed on this branch but still says last_updated: ${lastUpdated(after) ?? '(none)'} — a depth-1 CI clone dates the tracker by that line, so the roadmap step reads the edit as untouched work and reds 30 days on`,
      fix: `sed -i.bak "s/^last_updated: .*/last_updated: $(date -u +%F)/" ${renderFixShellArg(path, '<status.yml>')} && rm ${renderFixShellArg(path, '<status.yml>')}.bak`,
      at: path,
    }));
}

/** The trackers this checkout changed since `origin/main`; none when it has no base to read. */
export async function gitTrackerEdits(root: string): Promise<readonly TrackerEdit[]> {
  const changes = await changedSinceBase(root);
  if (changes.base === undefined) return [];
  const edits: TrackerEdit[] = [];
  for (const path of changes.changed.filter((one) => TRACKER.test(one))) {
    const file = Bun.file(`${root}/${path}`);
    if (!(await file.exists())) continue;
    edits.push({ path, before: await textAt(root, changes.base, path), after: await file.text() });
  }
  return edits;
}
