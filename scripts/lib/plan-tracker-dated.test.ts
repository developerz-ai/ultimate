// The dated-tracker rule: a changed tracker with an unchanged `last_updated` is the finding; a
// re-stamped edit, an untouched file and a brand-new tracker are not.

import { describe, expect, test } from 'bun:test';
import { undatedFindings } from './plan-tracker-dated';

const at = (date: string, focus: string): string =>
  `plan: x\nstatus: in_progress\nlast_updated: ${date}\ncurrent_focus: "${focus}"\n`;
const PATH = 'docs/plans/2026/11/14/101-x/status.yml';

describe('unit · plan trackers carry their own date', () => {
  test('an edit that leaves last_updated alone is X_PLAN_STATUS_UNDATED', () => {
    const [finding, ...rest] = undatedFindings([
      { path: PATH, before: at('2026-11-14', 'a'), after: at('2026-11-14', 'b') },
    ]);
    expect(rest).toEqual([]);
    expect(finding?.code).toBe('X_PLAN_STATUS_UNDATED');
    expect(finding?.at).toBe(PATH);
    expect(finding?.fix).toStartWith(
      `sed -i.bak "s/^last_updated: .*/last_updated: $(date -u +%F)/" ${PATH}`,
    );
  });

  test('a re-stamped edit, an unchanged file and a new tracker owe nothing', () => {
    expect(
      undatedFindings([
        { path: PATH, before: at('2026-11-14', 'a'), after: at('2026-11-16', 'b') },
        { path: PATH, before: at('2026-11-14', 'a'), after: at('2026-11-14', 'a') },
        { path: PATH, before: undefined, after: at('2026-11-16', 'new') },
      ]),
    ).toEqual([]);
  });
});
