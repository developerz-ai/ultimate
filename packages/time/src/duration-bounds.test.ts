// The bound `toMs` never had. Split from `duration.test.ts` so each file keeps one job: that one
// is about the duration VOCABULARY, this one is about the number arm that bypassed it.

import { describe, expect, test } from 'bun:test';
import { parseDuration, toMs, toSeconds } from './duration';

describe('toMs screens the number arm', () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
    test(`${String(value)} is refused, never passed through`, () => {
      expect(() => toMs(value)).toThrow(/X_INVARIANT/);
    });
  }

  test('the refusal names the duration, so a caller knows which argument was wrong', () => {
    expect(() => toMs(Number.NaN)).toThrow(/duration/);
  });

  // `Number(process.env.X)` on an unset variable is the way this arrives in production, and
  // `??` does not guard it: NaN is not nullish.
  test('an unset environment value is refused rather than becoming a bound nothing enforces', () => {
    const env: Record<string, string | undefined> = {};
    expect(() => toMs(Number(env['TTL_MS']))).toThrow(/X_INVARIANT/);
  });

  test('toSeconds inherits the screen, because it goes through toMs', () => {
    expect(() => toSeconds(Number.NaN)).toThrow(/X_INVARIANT/);
  });
});

describe('what the screen deliberately still accepts', () => {
  test('zero, negatives and fractions are all real durations here', () => {
    expect(toMs(0)).toBe(0);
    expect(toMs(-3000)).toBe(-3000);
    expect(toMs(1.5)).toBe(1.5);
    expect(Object.is(toMs(-0), -0)).toBe(true);
  });

  test('the string arm is unchanged, in both signs', () => {
    expect(toMs('90s')).toBe(90_000);
    expect(toMs('-1500ms')).toBe(parseDuration('-1500ms'));
    expect(toSeconds(-3000)).toBe(-3);
  });
});

// A refusal names the knob the APP AUTHOR wrote, never the framework function that happened to
// screen it. `toMs` is a name an app author reaching it through `clock.advance('3s')` or a
// notifier's `wait` never typed, so `pass a finite duration to toMs` sends them looking for a knob
// that does not exist in their code. `@ultimat3/jobs`' `finiteDurationMs` takes the same two names
// for the same reason; this is that shape on the exported conversion one tier down.
describe('the refusal names the caller, not the conversion', () => {
  const fixOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as { fix?: unknown }).fix as string;
    }
    return 'no-throw';
  };
  const causeOf = (run: () => unknown): string => {
    try {
      run();
    } catch (error) {
      return (error as { cause?: unknown }).cause as string;
    }
    return 'no-throw';
  };

  test('toMs names the subject and option it was given', () => {
    // The whole phrase, not `toContain('duration')`: `duration` is already the DEFAULT option, so
    // a substring assertion on it passes against the message this test exists to replace.
    expect(fixOf(() => toMs(Number.NaN, 'clock.advance', 'duration'))).toContain(
      'pass a finite duration to clock.advance',
    );
    expect(causeOf(() => toMs(Number.NaN, 'clock.advance', 'duration'))).toStartWith(
      'clock.advance duration is NaN',
    );
    // The internal name must be GONE, not merely joined by a better one.
    expect(fixOf(() => toMs(Number.NaN, 'clock.advance', 'duration'))).not.toContain('toMs');
  });

  test('a caller can rename the option too, because the knob is not always called duration', () => {
    expect(fixOf(() => toMs(Number.NaN, 'notify.plan', 'wait'))).toContain(
      'pass a finite wait to notify.plan',
    );
  });

  test('toSeconds threads the same two names', () => {
    expect(fixOf(() => toSeconds(Number.NaN, 'lease', 'ttl'))).toContain(
      'pass a finite ttl to lease',
    );
    expect(fixOf(() => toSeconds(Number.NaN, 'lease', 'ttl'))).not.toContain('toMs');
  });

  test('omitting them names the function the caller did write — the shipped message, unchanged', () => {
    // The parameters are OPTIONAL because `toMs` is published API: every existing call site keeps
    // compiling and keeps its message. A direct `toMs(x)` caller DID write `toMs`, so the default
    // is right for them; only a caller reached THROUGH it needs to say otherwise.
    expect(fixOf(() => toMs(Number.NaN))).toContain('pass a finite duration to toMs');
    // `toSeconds` names itself rather than the conversion it delegates to.
    expect(fixOf(() => toSeconds(Number.NaN))).toContain('pass a finite duration to toSeconds');
  });
});
