// The `unzoned-date` guard as `x new` emits it, run through the gate's own seam. The slipping forms
// (K18) are here: `timeZoneName` is not a zone, and `.toDateString()` / `.toTimeString()` format in
// the host's zone with no option to pass one. The rule's own cases ship beside it, in the app.

import { describe, expect, test } from 'bun:test';
import { shippedGuardFindings } from './shipped-guard-fixture';

const PAGE = 'apps/web/app/dashboard/page.tsx';

const findingsFor = (line: string) => shippedGuardFindings('unzoned-date', { [PAGE]: `${line}\n` });

describe('unit · shipped guard · unzoned-date', () => {
  test('timeZoneName with no timeZone is still unzoned', async () => {
    const findings = await findingsFor(
      "export const shown = (at: Date) => at.toLocaleString('en-US', { timeZoneName: 'short' });",
    );
    expect(findings.map((finding) => finding.code)).toEqual(['X_UNZONED_DATE']);
  });

  test('toDateString and toTimeString are refused, and the fix names the zoned call', async () => {
    const date = await findingsFor('export const d = (at: Date) => at.toDateString();');
    expect(date.map((finding) => finding.code)).toEqual(['X_UNZONED_DATE']);
    expect(date[0]?.fix).toContain("toLocaleDateString(locale, { timeZone: 'UTC' })");
    const time = await findingsFor('export const t = (at: Date) => at.toTimeString ();');
    expect(time.map((finding) => finding.code)).toEqual(['X_UNZONED_DATE']);
    expect(time[0]?.fix).toContain("toLocaleTimeString(locale, { timeZone: 'UTC' })");
    // The lookup is by method name: `toLocaleString` must not resolve off a prototype.
    const bare = await findingsFor(
      "export const n = (count: number) => count.toLocaleString('en');",
    );
    expect(bare[0]?.fix).toContain('Intl.NumberFormat');
  });

  test('a zone written as a key, a shorthand or beside timeZoneName satisfies it', async () => {
    for (const zoned of [
      "export const a = (at: Date) => at.toLocaleString('en', { timeZone: 'UTC' });",
      "export const b = (at: Date, timeZone: string) => at.toLocaleString('en', { timeZone });",
      "export const c = (at: Date, timeZone: string) => new Intl.DateTimeFormat('en', { timeZone, hour: 'numeric' }).format(at);",
      "export const d = (at: Date) => at.toLocaleString('en', { timeZoneName: 'short', timeZone: 'UTC' });",
      'export const e = (at: Date) => at.toISOString();',
    ]) {
      expect(await findingsFor(zoned)).toEqual([]);
    }
  });
});
