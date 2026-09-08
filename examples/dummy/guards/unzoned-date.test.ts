// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { unzonedDates } from './unzoned-date';

const file = (source: string) => [{ path: 'apps/web/app/dashboard/page.tsx', source }];

unitTest('toLocaleDateString with no timeZone is refused', () => {
  const findings = unzonedDates(file("const shown = at.toLocaleDateString('en-US');"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_UNZONED_DATE');
  expect(findings[0]?.fix).toContain('timeZone');
});

unitTest('an explicit zone satisfies it, even nested behind another call', () => {
  const zoned = "at.toLocaleDateString('en-US', { timeZone: zoneFor(actor) });";
  expect(unzonedDates(file(zoned))).toEqual([]);
});

unitTest('Intl.DateTimeFormat and toLocaleTimeString are the same rule', () => {
  expect(unzonedDates(file("new Intl.DateTimeFormat('en-US').format(at);"))).toHaveLength(1);
  expect(unzonedDates(file("at.toLocaleTimeString('en-US');"))).toHaveLength(1);
});

unitTest('a commented-out call is a note, not a call', () => {
  expect(unzonedDates(file("// at.toLocaleDateString('en-US');"))).toEqual([]);
});
