// `health-trust.ts`: the registry-trust row never answers green without the one-time password its
// command needs — no OTP is "unknown, here is the command", never a spawn and never healthy — and,
// with one, it reads trust-publishers' own verdict and codes.

import { describe, expect, test } from 'bun:test';
import { judgeTrust, TRUST_COMMAND, TRUST_FIX, trustReader } from './health-trust';
import type { RunResult } from './run';

const answer = (output: string): RunResult => ({
  command: [],
  code: 0,
  ok: true,
  output,
  durationMs: 1,
  timedOut: false,
});
const verdict = (read: Parameters<typeof judgeTrust>[0]) => {
  const out = judgeTrust(read);
  // `Array.isArray` keeps a readonly array in both branches, so the list is told apart by shape.
  if ('length' in out) return out.map((one) => one.code).join(',');
  return 'verdict' in out ? out.verdict : out.code;
};
const missing = {
  ok: false,
  findings: [{ code: 'X_TRUST_PUBLISHER_MISSING', cause: 'no publisher', fix: 'f' }],
};

describe('row · npm trusts only the release workflow', () => {
  test('no OTP is no verdict and never a spawn: the row names the command a person runs', async () => {
    const spawned: string[] = [];
    const runner = async (argv: readonly string[]) => {
      spawned.push(argv.join(' '));
      return answer('{"ok":true}');
    };
    for (const otp of [undefined, '', '  ']) {
      const read = await trustReader('.', { NPM_CONFIG_OTP: otp }, runner);
      expect(read).toEqual({ otp: false });
      const out = judgeTrust(read);
      expect(out).toMatchObject({ verdict: 'unverdicted', fix: TRUST_COMMAND });
    }
    expect(spawned).toEqual([]);
    expect(TRUST_COMMAND).toBe(
      'NPM_CONFIG_OTP=<code> bun run scripts/trust-publishers.ts --check --json',
    );
  });

  test('with an OTP it spawns exactly the check, and a clean answer is healthy', async () => {
    const spawned: string[] = [];
    const runner = async (argv: readonly string[]) => {
      spawned.push(argv.join(' '));
      return answer('npx: progress\n{"ok":true,"summary":"33/33 packages trust"}');
    };
    const read = await trustReader('.', { NPM_CONFIG_OTP: '123456' }, runner);
    expect(spawned).toEqual(['bun run scripts/trust-publishers.ts --check --json']);
    expect(verdict(read)).toBe('healthy');
  });

  test('a missing publisher is unhealthy, with the attach command as its fix', () => {
    const out = judgeTrust({ otp: true, doc: missing });
    expect(out).toMatchObject({ verdict: 'unhealthy', fix: TRUST_FIX });
    expect(TRUST_FIX).toBe('npm login && bun run scripts/trust-publishers.ts');
  });

  test('any other refusal passes its own findings through, never a verdict', () => {
    const tooOld = { ok: false, findings: [{ code: 'X_TRUST_NPM_TOO_OLD', cause: 'c', fix: 'f' }] };
    expect(verdict({ otp: true, doc: tooOld })).toBe('X_TRUST_NPM_TOO_OLD');
  });

  test('no document, or a refusal with no findings, is unreadable — never green', () => {
    expect(verdict({ otp: true, doc: undefined })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ otp: true, doc: { ok: false } })).toBe('X_HEALTH_ROW_UNREADABLE');
    expect(verdict({ otp: true, doc: { summary: 'no ok field' } })).toBe('X_HEALTH_ROW_UNREADABLE');
  });
});
