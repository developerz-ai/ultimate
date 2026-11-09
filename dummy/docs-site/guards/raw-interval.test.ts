// The rule, driven directly. Failure case first: a guard whose rule silently stopped matching is
// a green gate over the convention it was written to enforce.

import { expect, unitTest } from '@ultimat3/testing';
import { rawIntervals } from './raw-interval';

const file = (source: string) => [{ path: 'apps/web/app/feed/ticker.island.tsx', source }];

unitTest('a bare setInterval is refused, and the finding names the line', () => {
  const findings = rawIntervals(file('const a = 1;\nconst id = setInterval(poll, 5000);'));
  expect(findings).toHaveLength(1);
  expect(findings[0]?.code).toBe('X_RAW_INTERVAL');
  expect(findings[0]?.at).toBe('apps/web/app/feed/ticker.island.tsx:2');
});

unitTest('window., self. and globalThis. are the same rule', () => {
  expect(rawIntervals(file('window.setInterval(poll, 5000);'))).toHaveLength(1);
  expect(rawIntervals(file('self.setInterval(poll, 5000);'))).toHaveLength(1);
  expect(rawIntervals(file('globalThis.setInterval(poll, 5000);'))).toHaveLength(1);
});

unitTest('a why: on the line or the line above admits it', () => {
  expect(rawIntervals(file('setInterval(tick, 16); // why: a frame, not a read'))).toEqual([]);
  expect(rawIntervals(file('// why: a clock, not a read\nsetInterval(tick, 1000);'))).toEqual([]);
});

unitTest('visibleInterval, another object, a comment and a string are not calls', () => {
  expect(rawIntervals(file('visibleInterval(poll, 5000);'))).toEqual([]);
  expect(rawIntervals(file('timers.setInterval(poll, 5000);'))).toEqual([]);
  expect(rawIntervals(file('// setInterval(poll, 5000);'))).toEqual([]);
  expect(rawIntervals(file("const s = 'setInterval(poll)';"))).toEqual([]);
});
