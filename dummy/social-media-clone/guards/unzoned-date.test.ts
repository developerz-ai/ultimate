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

unitTest('the bare toLocaleString names the number exit, since a count matches it too', () => {
  const findings = unzonedDates(file("const shown = count.toLocaleString('en-US');"));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.fix).toContain('Intl.NumberFormat');
  expect(findings[0]?.fix).toContain('timeZone');
  // The dated forms are unambiguous and keep the zone-only fix.
  const dated = unzonedDates(file("at.toLocaleDateString('en-US');"));
  expect(dated[0]?.fix).not.toContain('Intl.NumberFormat');
});

unitTest('timeZoneName labels the zone, it does not choose one', () => {
  const named = "at.toLocaleString('en-US', { timeZoneName: 'short' });";
  expect(unzonedDates(file(named))).toHaveLength(1);
  const shorthand =
    "new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', timeZone }).format(at);";
  expect(unzonedDates(file(shorthand))).toEqual([]);
});

unitTest('a quoted key is the same key, and a quoted timeZoneName is still only a label', () => {
  expect(unzonedDates(file("at.toLocaleString('en-US', { 'timeZone': 'UTC' });"))).toEqual([]);
  expect(unzonedDates(file('at.toLocaleString("en-US", { "timeZone": zone });'))).toEqual([]);
  const label = "at.toLocaleString('en-US', { 'timeZoneName': 'short' });";
  expect(unzonedDates(file(label))).toHaveLength(1);
});

unitTest('toDateString and toTimeString name the zoned call', () => {
  const date = unzonedDates(file('const shown = at.toDateString();'));
  expect(date).toHaveLength(1);
  expect(date[0]?.fix).toContain('toLocaleDateString(locale');
  const time = unzonedDates(file('const shown = at.toTimeString();'));
  expect(time).toHaveLength(1);
  expect(time[0]?.fix).toContain('toLocaleTimeString(locale');
});

unitTest('a commented-out call is a note, not a call', () => {
  expect(unzonedDates(file("// at.toLocaleDateString('en-US');"))).toEqual([]);
});
