#!/usr/bin/env bun
// Enforce, as a build error, that `x` phones home to nobody: every host a non-test file in
// `packages/cli/src` spells in a string literal is either a name no machine answers for (RFC 2606 /
// 6761: `.invalid`, `.test`, `.example`, `example.*`, `localhost`, loopback) or a row of
// `CLI_OUTBOUND_ALLOWLIST` stating why it is there. A `fetch` to an analytics host is a literal
// host first, so it is refused before it can ship; telemetry would be a major, opt-in, and a row.
//
// A floor, not a proof: a host assembled at run time (`'https://' + name`) has no literal to read.
// Comments are not reachable and are not read. An allowance no file spells any more is reported.
//
//   bun run cli-outbound  ·  bun run scripts/cli-outbound.ts [--json]

import { renderFixShellArg } from '../packages/core/src/error-render';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'cli-outbound';
const SCOPE = 'packages/cli/src/';

/**
 * Every real host the CLI's source spells, and why. None is fetched by `x` on its own: each is a
 * link printed for a person, or a URL written into a generated app's files for that app's tools.
 * A new row is a decision a reviewer reads; a row for an analytics or update-check host is a major.
 */
export const CLI_OUTBOUND_ALLOWLIST = Object.freeze<Record<string, string>>({
  'github.com':
    "this repository's own pages: the Upgrading wiki link `x upgrade` prints and the credit line a scaffolded README carries — printed or written, never fetched",
  'cli.github.com':
    'where to install `gh`, printed in the X_GH_UNAVAILABLE fix — the person follows it, x does not',
  'biomejs.dev': 'the `$schema` URL in a scaffolded biome.json — the editor reads it, x never does',
  'your.domain':
    'a placeholder in the X_ISR fix line telling the author to set APP_URL to their own origin — printed, never fetched',
});

/** A file as the rule reads it: comments blanked, strings kept, every offset kept. */
export interface OutboundSource {
  readonly path: string;
  readonly stripped: string;
}

export interface OutboundSite {
  readonly file: string;
  readonly line: number;
  readonly host: string;
}

/** `scheme://host`: a bracketed IPv6 literal, or a run of name characters. `${…}` never matches. */
const URL_HOST =
  /\b(?:https?|wss?|ftp):\/\/(\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?)/g;

const RESERVED_TLDS = ['invalid', 'test', 'example', 'localhost'] as const;
const RESERVED_SECOND = /^(?:.+\.)?example\.(?:com|net|org)$/;
const LOOPBACK = /^(?:127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[(?:0*:)*:?0*1\]|\[::\])$/;

/** A name no machine answers for on the public internet: reaching it cannot report anything. */
export function isReservedHost(host: string): boolean {
  if (LOOPBACK.test(host)) return true;
  if (RESERVED_SECOND.test(host)) return true;
  const tld = host.split('.').at(-1) ?? '';
  return (RESERVED_TLDS as readonly string[]).includes(tld);
}

/** Every non-reserved host the file spells in a string, in source order. */
export function outboundHosts(file: OutboundSource): readonly OutboundSite[] {
  if (!file.path.startsWith(SCOPE) || isTestPath(file.path)) return [];
  const found: OutboundSite[] = [];
  for (const match of file.stripped.matchAll(URL_HOST)) {
    const host = (match[1] ?? '').toLowerCase();
    if (isReservedHost(host)) continue;
    found.push({ file: file.path, line: lineOf(file.stripped, match.index), host });
  }
  return found;
}

const undeclared = (site: OutboundSite): Finding => {
  const host = renderFixShellArg(site.host, '<host>');
  const file = renderFixShellArg(site.file, '<file>');
  return {
    code: 'X_CLI_OUTBOUND_UNDECLARED',
    at: `${site.file}:${site.line}`,
    cause: `${site.file}:${site.line} spells the host ${site.host}, which is not in CLI_OUTBOUND_ALLOWLIST; x sends nothing anywhere, and a host nobody wrote a reason for is how telemetry arrives`,
    fix: `bun run scripts/cli-outbound.ts --json   # then delete the URL at ${file}:${site.line} that names ${host} (an example takes app.example.com), or add '${site.host}': '<the reason the CLI dials it>' to CLI_OUTBOUND_ALLOWLIST in scripts/cli-outbound.ts`,
  };
};

const stale = (host: string): Finding => ({
  code: 'X_CLI_OUTBOUND_ALLOWANCE_STALE',
  at: 'scripts/cli-outbound.ts',
  cause: `CLI_OUTBOUND_ALLOWLIST allows ${host} and no non-test file in packages/cli/src spells it, so the row excuses a host nothing reaches and would excuse the next one silently`,
  fix: `grep -n ${renderFixShellArg(host, '<host>')} scripts/cli-outbound.ts   # delete that row from CLI_OUTBOUND_ALLOWLIST, then: bun run scripts/cli-outbound.ts --json`,
});

export function cliOutboundResult(files: readonly OutboundSource[]): ScriptResult {
  const sites = files.flatMap(outboundHosts);
  const seen = new Set(sites.map((site) => site.host));
  const findings = [
    ...sites.filter((site) => !Object.hasOwn(CLI_OUTBOUND_ALLOWLIST, site.host)).map(undeclared),
    ...Object.keys(CLI_OUTBOUND_ALLOWLIST)
      .filter((host) => !seen.has(host))
      .map(stale),
  ];
  const scanned = files.filter((file) => file.path.startsWith(SCOPE)).length;
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${scanned} CLI files, every host reserved or one of ${Object.keys(CLI_OUTBOUND_ALLOWLIST).length} allowed`
        : `${findings.length} CLI outbound finding(s)`,
    findings,
    data: { files: scanned, sites },
  };
}

/** The rule as a host check: `scripts/verify.ts` runs it on the gate's `boundaries` step. */
export async function cliOutboundFindings(root: string): Promise<readonly Finding[]> {
  return cliOutboundResult(await corpus(root, 'shipped')).findings ?? [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(cliOutboundResult(await corpus(repoRoot(), 'shipped')), args.json);
}
