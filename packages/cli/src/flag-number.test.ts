// Three commands took an integer flag through a bare `Number.parseInt`, and each turned a check
// into one that cannot fail. These are the exact values that got through.

import { describe, expect, test } from 'bun:test';
import { intFlagOr, PORT_RANGE, portPairAfter, readIntFlag } from './flag-number';
import type { CommandSpec, ParsedArgs } from './parse';
import { parseArgs } from './parse';
import { thrownBy } from './thrown-by';

const SPEC: CommandSpec = {
  name: 'doctor',
  summary: 'fixture',
  usage: 'x doctor',
  flags: [
    { name: 'port', type: 'string', summary: 'fixture' },
    { name: 'workers', type: 'string', summary: 'fixture' },
  ],
};

const argsFor = (argv: readonly string[]): ParsedArgs => parseArgs(argv, [SPEC]);

const PORT = {
  name: 'port',
  command: 'doctor',
  ...PORT_RANGE,
  example: 'x doctor --port 3000',
} as const;

describe('unit · an integer flag is validated, never coerced', () => {
  // `x doctor --port abc` probed `Number.NaN`, and `portFree(NaN)` answers "free" — so the port
  // check reported a clean environment while 3000 was occupied and `x dev` then failed.
  test('a non-numeric value is X_CLI_BAD_FLAG, not NaN', () => {
    expect(Number.isNaN(Number.parseInt('abc', 10))).toBe(true);
    const failure = thrownBy(() => readIntFlag(argsFor(['doctor', '--port', 'abc']), PORT));
    expect(failure.code).toBe('X_CLI_BAD_FLAG');
    expect(failure.cause).toContain('expects an integer from 0 to 65535, got "abc"');
    expect(failure.fix).toBe('x doctor --port 3000');
  });

  // The two `parseInt` accepts silently: a numeric prefix, and a decimal it truncates.
  test('a numeric PREFIX and a decimal are both refused', () => {
    expect(Number.parseInt('4abc', 10)).toBe(4);
    expect(Number.parseInt('4.9', 10)).toBe(4);
    for (const raw of ['4abc', '4.9', '+4', ' 4', '0x10', '-1']) {
      expect(thrownBy(() => readIntFlag(argsFor(['doctor', '--port', raw]), PORT)).code).toBe(
        'X_CLI_BAD_FLAG',
      );
    }
  });

  test('a port outside the TCP range is refused at both ends', () => {
    // 0 is "let the kernel pick", which is how `x dev --port 0` boots a test server — the same
    // range `serve.ts`'s `portValue` enforces on `PORT`.
    expect(readIntFlag(argsFor(['doctor', '--port', '0']), PORT)).toBe(0);
    expect(thrownBy(() => readIntFlag(argsFor(['doctor', '--port', '65536']), PORT)).code).toBe(
      'X_CLI_BAD_FLAG',
    );
    expect(readIntFlag(argsFor(['doctor', '--port', '65535']), PORT)).toBe(65_535);
  });

  test('an absent flag is undefined, and the default form fills it in', () => {
    expect(readIntFlag(argsFor(['doctor']), PORT)).toBeUndefined();
    expect(intFlagOr(argsFor(['doctor']), PORT, 3000)).toBe(3000);
    expect(intFlagOr(argsFor(['doctor', '--port', '8080']), PORT, 3000)).toBe(8080);
  });

  test('the fix is a command a shell can run, never a placeholder', () => {
    expect(
      thrownBy(() => readIntFlag(argsFor(['doctor', '--port', 'abc']), PORT)).fix,
    ).not.toContain('<');
  });
});

/**
 * `x dev --port N` binds N **and** N + 1, so a suggestion built from `neighbouringPort` names the
 * very socket the caller was just told is taken: `x dev --port 3999` died on 4000 and answered
 * `x dev --port 4000`, and `x doctor` reported the same thing about the same pair. A fix line that
 * hands back one of the two ports that just failed is the failure repeated, not ended.
 */
describe('unit · a port suggestion whose PAIR is clear of the pair that failed', () => {
  test('it moves two, so neither the port nor its neighbour is suggested again', () => {
    expect(portPairAfter(3000)).toBe(3002);
    expect(portPairAfter(3999)).toBe(4001);
  });

  test('every answer is a port, and so is its neighbour — at the top of the range too', () => {
    for (const port of [
      0,
      1,
      3000,
      PORT_RANGE.max - 3,
      PORT_RANGE.max - 2,
      PORT_RANGE.max - 1,
      PORT_RANGE.max,
    ]) {
      const suggested = portPairAfter(port);
      expect(suggested).toBeGreaterThanOrEqual(PORT_RANGE.min);
      // The suggestion's OWN neighbour has to exist: `x dev` refuses `PORT` at the top of the
      // range (`syncPortFor`), so a suggestion of 65535 is a second refusal.
      expect(suggested + 1).toBeLessThanOrEqual(PORT_RANGE.max);
      expect(suggested).not.toBe(port);
      expect(suggested).not.toBe(port + 1);
      expect(suggested + 1).not.toBe(port);
      expect(suggested + 1).not.toBe(port + 1);
    }
  });
});
