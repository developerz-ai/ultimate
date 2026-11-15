// Single responsibility: pins `redactValues()` — what it refuses at registration, and that a
// registered pattern's match survives in no sink: the log line's message and fields, the monitor
// envelope's exception, extras and meta. Every pattern here matches only its own probe prefix, so a
// matcher this file registers (process-wide, append-only, like `redactKeys`) rewrites no other test.

import { afterEach, describe, expect, test } from 'bun:test';
import { frozenClock } from './clock';
import { configureErrorReporting, errorReport, resetErrorReporting } from './error-reporter';
import { sentryEnvelope } from './error-reporter-sentry';
import { UltimateError } from './errors';
import { redactValues, structuredLogger } from './logger';
import { RedactPatternUnsafeError, redactedValue } from './redact-values';

afterEach(() => {
  resetErrorReporting();
});

const codeOf = (fn: () => unknown): unknown => {
  try {
    fn();
  } catch (thrown) {
    return thrown;
  }
  return expect.unreachable('redactValues accepted a pattern it must refuse');
};

describe('redactValues · registration screen', () => {
  test('a pattern without the g flag is refused: it would replace the first match only', () => {
    const thrown = codeOf(() => redactValues([{ pattern: /rvnog_[a-z]{6}/, replace: '[k]' }]));
    expect(thrown).toBeInstanceOf(RedactPatternUnsafeError);
    expect((thrown as RedactPatternUnsafeError).code).toBe('X_REDACT_PATTERN_UNSAFE');
    expect((thrown as RedactPatternUnsafeError).fix).toContain('/rvnog_[a-z]{6}/g');
  });

  test('a sticky pattern is refused: it only matches at the start of a value', () => {
    expect(() => redactValues([{ pattern: /rvsticky_\d+/gy, replace: '[k]' }])).toThrow(
      RedactPatternUnsafeError,
    );
  });

  test.each([
    ['(a+)+$'],
    ['(\\w+\\s?)*$'],
    ['((ab)*c)+'],
    ['(x{2,})+'],
    ['(?:[a-z]+\\.)*rvnested'],
    ['(a+){2,40}b'],
    ['(.*a){12}'],
  ])('a nested unbounded quantifier is refused at registration: /%s/g', (source) => {
    expect(() => redactValues([{ pattern: new RegExp(source, 'g'), replace: '[k]' }])).toThrow(
      RedactPatternUnsafeError,
    );
  });

  test('a pattern that matches the empty string is refused: it would splice into every value', () => {
    expect(() => redactValues([{ pattern: /(?:rvempty)*/g, replace: '[k]' }])).toThrow(
      RedactPatternUnsafeError,
    );
  });

  test('one bad matcher refuses the whole list: nothing from it is registered', () => {
    expect(() =>
      redactValues([
        { pattern: /rvatomic_[0-9]{4}/g, replace: '[k]' },
        { pattern: /(rv+)+/g, replace: '[k]' },
      ]),
    ).toThrow(RedactPatternUnsafeError);
    expect(redactedValue('rvatomic_1234')).toBe('rvatomic_1234');
  });

  test('single quantifiers, alternation and character classes register', () => {
    redactValues([
      { pattern: /rvok_(?:[a-z]|[0-9])+/g, replace: '[ok]' },
      { pattern: /rvclass_[(+)*]{3}/g, replace: '[cls]' },
      { pattern: /rvgroup_(?:ab)+\d{2,8}/g, replace: '[grp]' },
      { pattern: /rvopt_(?:x+)?(?:y{2,3}){0,1}z/g, replace: '[opt]' },
    ]);
    expect(redactedValue('a rvok_x9z b rvok_q')).toBe('a [ok] b [ok]');
    expect(redactedValue('rvclass_(+)')).toBe('[cls]');
    expect(redactedValue('rvgroup_abab42')).toBe('[grp]');
    expect(redactedValue('rvopt_xxyyz')).toBe('[opt]');
  });
});

describe('redactValues · the sinks', () => {
  test('a log line: message, nested fields, an Error, and a child bound BEFORE registration', () => {
    const lines: string[] = [];
    const log = structuredLogger({ level: 'info', writer: (line) => lines.push(line) });
    const early = log.child({ bound: 'dial rvlog_AAAA1111' });
    redactValues([{ pattern: /rvlog_[A-Z0-9]{8}/g, replace: '[card]' }]);
    early.info('charged rvlog_BBBB2222 twice', {
      nested: { list: ['rvlog_CCCC3333'] },
      failure: new Error('declined rvlog_DDDD4444'),
    });
    const text = lines.join('\n');
    expect(text).not.toMatch(/rvlog_[A-Z0-9]{8}/);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      msg: 'charged [card] twice',
      bound: 'dial [card]',
      nested: { list: ['[card]'] },
      failure: { message: 'declined [card]' },
    });
  });

  test('the monitor envelope: exception value, fix, extras and meta', () => {
    redactValues([{ pattern: /rvsentry_[a-f0-9]{8}/g, replace: '[acct]' }]);
    configureErrorReporting({ clock: frozenClock(new Date('2026-11-14T00:00:00Z')) });
    const built = errorReport(
      new UltimateError({
        code: 'X_ENVELOPE_FIXTURE',
        cause: 'account rvsentry_0011aabb refused',
        fix: 'unlock rvsentry_0011aabb in the billing console, then retry the charge',
        meta: { deep: { id: 'rvsentry_22334455' } },
      }),
      { source: 'http', scope: { extra: { note: ['rvsentry_66778899'] } } },
    );
    const payload = sentryEnvelope(built, {
      dsn: 'https://k@h.example/1',
      eventId: 'f'.repeat(32),
    });
    expect(payload).not.toMatch(/rvsentry_[a-f0-9]{8}/);
    expect(payload).toContain('account [acct] refused');
  });
});

/** Deterministic, so a failure is a seed to replay rather than a flake. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

describe('redactValues · property', () => {
  test('no value a registered pattern matches survives in message, extras or meta', () => {
    redactValues([{ pattern: /rvprop-[A-Za-z0-9]{12,20}/g, replace: '[x]' }]);
    const shape = /rvprop-[A-Za-z0-9]{12,20}/;
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    const noise = ' :/=,"\'\n\t{}[]é😀-_';
    const random = prng(20261114);
    const pick = (from: string): string => from[Math.floor(random() * from.length)] ?? '';
    const secret = (): string => {
      const length = 12 + Math.floor(random() * 9);
      return `rvprop-${Array.from({ length }, () => pick(alphabet)).join('')}`;
    };
    const around = (): string =>
      `${Array.from({ length: Math.floor(random() * 6) }, () => pick(noise)).join('')}${secret()}${pick(noise)}`;

    configureErrorReporting({ clock: frozenClock(new Date('2026-11-14T00:00:00Z')) });
    for (let run = 0; run < 200; run += 1) {
      const lines: string[] = [];
      const log = structuredLogger({ level: 'info', writer: (line) => lines.push(line) });
      log.info(around() + around(), { a: around(), b: { c: [around(), { d: around() }] } });
      const built = errorReport(
        new UltimateError({
          code: 'X_ENVELOPE_FIXTURE',
          cause: around(),
          fix: 'retry the request',
          meta: { m: around(), n: [around()] },
        }),
        { source: 'job', scope: { extra: { e: around() } } },
      );
      const payload = sentryEnvelope(built, {
        dsn: 'https://k@h.example/1',
        eventId: 'f'.repeat(32),
      });
      for (const text of [...lines, payload]) {
        if (shape.test(text)) expect.unreachable(`run ${run} leaked: ${text}`);
      }
    }
  });
});
