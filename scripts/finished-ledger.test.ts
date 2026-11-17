// `finished-ledger.ts`: the one-ledger row over fixture trackers and a fixture Known-Gaps page.

import { describe, expect, test } from 'bun:test';
import { ledgerRow, undecidedSections } from './finished-ledger';

const DECIDED = [
  '## Open by decision',
  '',
  '| Gap | Why it stays |',
  '|---|---|',
  '| a | b |',
  '',
  '## Carried',
  '',
  '| Gap | Decision | Why |',
  '|---|---|---|',
  '| c | deferred | d |',
  '| e | rejected | f |',
  '',
  '## Closed',
  '',
  '| Gap | Fixed in | Pinned |',
  '|---|---|---|',
  '| g | **1.0.0** | h |',
].join('\n');
const ONE = [{ path: 'docs/plans/a/status.yml', status: 'in_progress' }];

describe('finished · one-ledger', () => {
  test('one tracker in progress and every row decided: green', () => {
    expect(ledgerRow(ONE, DECIDED).verdict).toBe('green');
  });

  test('two trackers in progress is red', () => {
    const two = [...ONE, { path: 'docs/plans/b/status.yml', status: 'in_progress' }];
    const row = ledgerRow(two, DECIDED);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.code).toBe('X_FINISHED_LEDGER_OPEN');
  });

  test('a row under ## Open is owed work: red, at its first row', () => {
    const page = `## Open\n\n| Gap | Symptom |\n|---|---|\n| x | y |\n| z | w |\n\n${DECIDED}`;
    expect(undecidedSections(page)).toEqual([{ heading: 'Open', line: 5, rows: 2 }]);
    const row = ledgerRow(ONE, page);
    expect(row.verdict).toBe('red');
    expect(row.findings[0]?.at).toBe('wiki/Known-Gaps.md:5');
  });

  test('a Decision cell reading build is owed work', () => {
    const page = DECIDED.replace('| c | deferred | d |', '| c | build | d |');
    expect(ledgerRow(ONE, page).verdict).toBe('red');
  });
});
