import { describe, expect, test } from 'bun:test';
import { devPortFor } from './dev-port';
import { parseArgs } from './parse';
import { SPECS } from './registry';

const args = (...argv: string[]) => parseArgs(['dev', ...argv], SPECS);

// Row i: the flag's `default: '3000'` always won, so `PORT` in `.env.development` was never read.
describe('unit · x dev binds --port, then PORT, then 3000', () => {
  test('PORT from the environment is used when no flag is given', () => {
    expect(devPortFor(args(), { PORT: '4100' })).toBe(4100);
  });

  test('--port wins over PORT, and nothing at all is 3000', () => {
    expect(devPortFor(args('--port', '5000'), { PORT: '4100' })).toBe(5000);
    expect(devPortFor(args(), {})).toBe(3000);
  });

  test('a PORT that is not a port is refused, never half-read', () => {
    expect(() => devPortFor(args(), { PORT: '80abc' })).toThrow(
      expect.objectContaining({ code: 'X_PORT_INVALID' }),
    );
  });
});
