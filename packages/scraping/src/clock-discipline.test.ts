// Axiom 3, applied to this package's own seam: "every wait goes through the clock" is a rule, so
// it is a build error. Without this file the rule is a sentence in a header comment, and the first
// `await Bun.sleep(800)` somebody adds to a retry loop makes one test file take a minute.

import { describe, expect, test } from 'bun:test';

/** The one file allowed to make time pass, and the one allowed to hand a deadline to `fetch`. */
const CLOCK_FILE = 'clock.ts';
const DEADLINE_FILE = 'http.ts';

const TIMERS = /\b(?:setTimeout|setInterval|Bun\.sleep|AbortSignal\.timeout)\s*\(/;

describe('unit · no file but clock.ts may make time pass', () => {
  test('nothing outside the clock reaches for a timer', async () => {
    const glob = new Bun.Glob('*.ts');
    const offenders: string[] = [];
    for await (const path of glob.scan({ cwd: import.meta.dir, absolute: false })) {
      if (path === CLOCK_FILE || path.endsWith('.test.ts')) continue;
      const source = await Bun.file(`${import.meta.dir}/${path}`).text();
      // Comments quote the banned spellings on purpose (they explain why the rule exists), so the
      // scan reads code only — a rule that could be defeated by a comment is not a rule.
      const code = source.replaceAll(/\/\/[^\n]*|\/\*[\S\s]*?\*\//g, '');
      if (!TIMERS.test(code)) continue;
      // `http.ts` hands ONE deadline to the platform's own `fetch`, which is not a wait this
      // package performs — and under a test clock a slept deadline fires on the next microtask
      // and cancels every request. Pinned here, in one place, with the reason.
      if (path === DEADLINE_FILE && !/\b(?:setTimeout|setInterval|Bun\.sleep)\s*\(/.test(code)) {
        continue;
      }
      offenders.push(path);
    }
    expect(offenders).toEqual([]);
  });

  test('the scan can see a violation — it is not vacuously green', async () => {
    // The failure mode this file exists to prevent, one level up: a matcher that matches nothing
    // makes every assertion above it meaningless.
    expect(TIMERS.test('await Bun.sleep(800);')).toBe(true);
    expect(TIMERS.test('const t = setTimeout(fn, 10);')).toBe(true);
    expect(TIMERS.test('await clock.sleep(800);')).toBe(false);
  });
});
