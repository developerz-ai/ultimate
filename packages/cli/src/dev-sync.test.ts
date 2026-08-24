// The one arithmetic in the `sync` role's boot: the port it listens on is `PORT + 1`, and at the
// top of the range that number is not a port. `x dev --port 65535` asked Bun for 65536 and got a
// bare `RangeError`, which reached the terminal as `X_CLI_UNEXPECTED` with `fix: x doctor --json`
// — a refusal that names neither the flag that caused it nor a value that would work.

import { describe, expect, test } from 'bun:test';
import { isUltimateError } from '@ultimat3/core';
import { syncBindRefusal, syncPortFor } from './dev-sync';
import { fixProblem } from './error-contract';
import { PORT_RANGE } from './flag-number';

const refusal = (port: number): { code: string; cause: string; fix: string } => {
  try {
    syncPortFor(port);
  } catch (error) {
    if (isUltimateError(error)) return { code: error.code, cause: error.cause, fix: error.fix };
    return expect.unreachable(`not an UltimateError: ${String(error)}`);
  }
  return expect.unreachable(`syncPortFor(${port}) did not refuse`);
};

describe('unit · the port the sync node listens on', () => {
  test('is one above the web role`s, which is what compose and the chart both derive', () => {
    expect(syncPortFor(3000)).toBe(3001);
    expect(syncPortFor(PORT_RANGE.max - 1)).toBe(PORT_RANGE.max);
  });

  test('0 stays 0 — the kernel picks, and PORT + 1 would pick a specific port instead', () => {
    expect(syncPortFor(0)).toBe(0);
  });

  test('the top of the range is refused with a code, not a RangeError from inside Bun', () => {
    const { code, cause, fix } = refusal(PORT_RANGE.max);
    expect(code).toBe('X_PORT_INVALID');
    // The number it would have asked for, so the reader does not have to do the arithmetic.
    expect(cause).toContain(String(PORT_RANGE.max + 1));
    expect(cause).toContain(String(PORT_RANGE.max));
    // A value that works, not a diagnostic command: `x doctor --json` is what this used to answer.
    expect(fix).toContain(`--port ${PORT_RANGE.max - 1}`);
    expect(fix).not.toContain('x doctor');
    expect(fixProblem(fix)).toBeUndefined();
  });

  // Not clamped, deliberately. `PORT + 1` is the rule `docker/docker-compose.prod.yml` publishes
  // `3001:3001` from and `docker/helm` derives `PORT = .port - 1` from, so a node silently on
  // `PORT - 1` is a socket nothing else in the deployment computes.
  test('and the refusal is a refusal — no port is returned for it', () => {
    expect(() => syncPortFor(PORT_RANGE.max)).toThrow();
  });
});

describe('unit · the sync node cannot bind, and says which port', () => {
  // `x dev --port 3999` printed `web listening on 3999 … sync node ready`, then died with
  // `X_CLI_UNEXPECTED` whose cause was `Error: Failed to start server. Is port 4000 in use?` —
  // a caught value rendered verbatim into a refusal, under a code that means "the CLI itself
  // failed" and a `fix: x doctor --json` that then reported the environment shippable (#F5).
  test('a taken neighbour is X_PORT_IN_USE, not X_CLI_UNEXPECTED over a rendered Error', async () => {
    const refusal = await syncBindRefusal(3999, 4000, async () => false);
    expect(refusal?.code).toBe('X_PORT_IN_USE');
    expect(refusal?.cause).toContain('4000');
    expect(refusal?.cause).toContain('3999');
    // Neither half of the cause may be the caught value: no `Error:` prefix, no Bun sentence.
    expect(refusal?.cause).not.toContain('Failed to start server');
    expect(refusal?.cause).not.toContain('Error:');
  });

  test('its fix is a command that ends the failure, never a diagnostic that missed it', async () => {
    const refusal = await syncBindRefusal(3999, 4000, async () => false);
    expect(refusal?.fix).toContain('x dev --port 4000');
    expect(refusal?.fix).not.toContain('x doctor');
    expect(fixProblem(refusal?.fix ?? '')).toBeUndefined();
  });

  // The other direction, and the one that keeps this from being a catch-all: a listener that
  // failed for any other reason must reach the caller as the value it was.
  test('a free port produces no refusal, so the original failure is re-thrown', async () => {
    expect(await syncBindRefusal(3999, 4000, async () => true)).toBeUndefined();
  });
});
