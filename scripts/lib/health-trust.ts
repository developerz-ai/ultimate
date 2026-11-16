// The registry-trust row: whether every published package still names this repository's release
// workflow as its OIDC trusted publisher. Its one command needs a fresh npm one-time password no
// scheduled run holds, so without `NPM_CONFIG_OTP` the row is no verdict that names the command a
// person runs — never a spawn that would read a refused session as an answer, never a false green.

import type { ChildFinding } from './health-narrow';
import { jsonDocument, narrowChildDoc } from './health-narrow';
import type { RowVerdict } from './health-rule';
import type { Finding } from './log';
import type { RunResult } from './run';
import { run } from './run';

const ARGV = ['bun', 'run', 'scripts/trust-publishers.ts', '--check', '--json'] as const;

// Exported for the brief's test: the command the row runs, with the one secret it cannot hold.
export const TRUST_COMMAND = `NPM_CONFIG_OTP=<code> ${ARGV.join(' ')}`;
/** Attaching a publisher is an account-level trust change: an npm session carrying 2FA first. */
export const TRUST_FIX = 'npm login && bun run scripts/trust-publishers.ts';

/** No OTP: nothing was spawned. With one: trust-publishers' parsed `--json` document. */
export type TrustRead = { readonly otp: false } | { readonly otp: true; readonly doc: unknown };

export type Runner = (argv: readonly string[], cwd: string) => Promise<RunResult>;

const runInRoot: Runner = (argv, cwd) => run(argv, { cwd });

export const trustReader = async (
  root: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
  runner: Runner = runInRoot,
): Promise<TrustRead> => {
  if ((env['NPM_CONFIG_OTP'] ?? '').trim() === '') return { otp: false };
  return { otp: true, doc: jsonDocument((await runner(ARGV, root)).output) };
};

const unreadable = (detail: string): Finding => ({
  code: 'X_HEALTH_ROW_UNREADABLE',
  cause: `the registry-trust row could not be read: ${TRUST_COMMAND} — ${detail}`,
  fix: 'bun run scripts/health.ts --json',
  at: 'scripts/health.ts',
});

const isMissing = (finding: ChildFinding): boolean => finding.code === 'X_TRUST_PUBLISHER_MISSING';

/**
 * A missing publisher is UNHEALTHY: the next release would fall back to token auth this repository
 * removed. npm answers a refused session (an expired OTP) the same way under `--check`, so the
 * reason says so. Any other refusal — npm too old, no publishable workspace — is passed through.
 */
export const judgeTrust = (read: TrustRead): RowVerdict | Finding | readonly ChildFinding[] => {
  const base = { row: 'registry-trust' as const };
  if (!read.otp) {
    return {
      ...base,
      verdict: 'unverdicted',
      reason:
        'needs a fresh npm one-time password no scheduled run holds — unknown, never filed: a person with npm 2FA runs the fix',
      fix: TRUST_COMMAND,
    };
  }
  const doc = narrowChildDoc(read.doc);
  if (doc === undefined) return unreadable('trust-publishers printed no JSON document');
  if (doc.ok) {
    return {
      ...base,
      verdict: 'healthy',
      reason: 'every published package trusts release.yml in the npm-publish environment',
    };
  }
  if (doc.findings.length === 0) return unreadable('it refused without a readable findings block');
  const missing = doc.findings.filter(isMissing);
  if (missing.length < doc.findings.length) return doc.findings;
  return {
    ...base,
    verdict: 'unhealthy',
    reason: `${missing.length} package(s) name no trusted publisher (X_TRUST_PUBLISHER_MISSING) — an expired OTP reads the same: re-run with a fresh one before filing`,
    fix: TRUST_FIX,
  };
};
