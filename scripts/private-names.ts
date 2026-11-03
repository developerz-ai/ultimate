#!/usr/bin/env bun
// Enforce, as a build error, that no tracked file or path names a private adopter: the names come
// from the ULTIMATE_PRIVATE_NAMES secret, never from a committed file, and a finding prints the
// file:line and the entry's 1-based index, never the name or the text it matched.
//
// WHY THE LIST IS A SECRET. A committed list, plain or hashed, publishes the names it guards (a
// short name hashes back by brute force). CI logs are public, and Actions masks a secret's whole
// value, not each line of it, so the output carries indices only.
//
// UNSET IS A SKIP, and says so: a fork's pull request cannot read the secret and receives an empty
// string. The skip note and the "checked" line never appear together, so a skip cannot read as a
// scan. The one exception is a push to main on Actions, where the secret always exists: missing
// there, the guard would pass forever while scanning nothing, so it is red. Untracked files git does
// not ignore are scanned too, so a new page is caught before its commit. CHANGELOG.md,
// docs/history/ and docs/plans/ are records and are not scanned.
//
//   bun run private-names  ·  bun run scripts/private-names.ts [--json]

// why: Bun has no synchronous stderr write; the gate may exit right after the step.
import { writeSync } from 'node:fs';
import { renderFixShellArg } from '@ultimat3/core';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { ScriptError } from './lib/script-error';

const SCRIPT = 'private-names';

/** The one variable the names are read from. */
export const ENV_NAME = 'ULTIMATE_PRIVATE_NAMES';

export const SKIP_NOTE = `private-names: skipped, ${ENV_NAME} is unset`;

/** Records whose history stands: the scrub never rewrites them. */
const EXCLUDED = ['CHANGELOG.md', 'docs/history/', 'docs/plans/'];

/** Letters, digits, `.` and `-` make a token; a name matches a WHOLE token, never part of one. */
const TOKEN = /[a-z0-9.-]+/g;

/** Newline- or comma-separated, trimmed, lowercased; unset, empty and whitespace are all none. */
export function namesFromEnv(env: Readonly<Record<string, string | undefined>>): readonly string[] {
  return (env[ENV_NAME] ?? '')
    .split(/[\n,]/)
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
}

/**
 * The 1-based index of the entry a token is, or undefined. A token loses a leading or trailing `.`
 * or `-` first (a sentence's full stop), and a dotted entry also matches as a subdomain
 * (`www.<entry>`), since a domain's host part is still the name.
 */
export function tokenMatch(raw: string, names: readonly string[]): number | undefined {
  const word = raw.replace(/^[.-]+|[.-]+$/g, '');
  for (const [index, name] of names.entries()) {
    if (word === name || (name.includes('.') && word.endsWith(`.${name}`))) return index + 1;
  }
  return undefined;
}

const firstMatch = (text: string, names: readonly string[]): number | undefined => {
  for (const [token] of text.toLowerCase().matchAll(TOKEN)) {
    const index = tokenMatch(token, names);
    if (index !== undefined) return index;
  }
  return undefined;
};

export interface PrivateNameHit {
  /** The tracked file, or `undefined` when its own path carries a name and may not be printed. */
  readonly file: string | undefined;
  /** Its 1-based position in `git ls-files`, which locates a file whose path cannot be printed. */
  readonly position: number;
  /** 0 for a hit in the path itself. */
  readonly line: number;
  readonly index: number;
}

export interface PrivateNameScan {
  readonly names: number;
  readonly files: number;
  readonly hits: readonly PrivateNameHit[];
}

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8000).includes(0);

/** Files read at once: enough to keep the disk busy, few enough to hold no tree in memory. */
const BATCH = 64;

/** One tracked file's hits: its path, then each line. A binary or deleted file has no lines. */
async function scanFile(
  root: string,
  path: string,
  position: number,
  names: readonly string[],
): Promise<readonly PrivateNameHit[]> {
  const hits: PrivateNameHit[] = [];
  const pathIndex = firstMatch(path, names);
  const file = pathIndex === undefined ? path : undefined;
  if (pathIndex !== undefined) hits.push({ file, position, line: 0, index: pathIndex });
  const handle = Bun.file(`${root}/${path}`);
  // A path the index holds but the work tree deleted has no lines to read.
  if (!(await handle.exists())) return hits;
  const bytes = await handle.bytes();
  if (isBinary(bytes)) return hits;
  for (const [line, text] of new TextDecoder().decode(bytes).split('\n').entries()) {
    const index = firstMatch(text, names);
    if (index !== undefined) hits.push({ file, position, line: line + 1, index });
  }
  return hits;
}

/** Tracked files and the untracked ones git does not ignore: what the next commit can carry. */
const LIST_FILES = ['ls-files', '--cached', '--others', '--exclude-standard'] as const;

/** Every tracked or addable file outside the records; `undefined` when skipped. */
export async function scanPrivateNames(
  root: string,
  names: readonly string[],
): Promise<PrivateNameScan | undefined> {
  if (names.length === 0) return undefined;
  const listed = Bun.spawnSync(['git', ...LIST_FILES, '-z'], { cwd: root, timeout: 30_000 });
  // A tree git cannot list would scan nothing and pass: that is a refusal, never a green.
  if (listed.exitCode !== 0) {
    throw new ScriptError({
      code: 'X_PRIVATE_NAME',
      cause: `git ls-files failed in ${root}, so no tracked file was read and a clean run would prove nothing`,
      fix: 'git ls-files   # run from the repository root, then: bun run private-names --json',
    });
  }
  const scanned = listed.stdout
    .toString()
    .split('\0')
    .map((path, at) => ({ path, position: at + 1 }))
    .filter(({ path }) => path.length > 0 && !EXCLUDED.some((prefix) => path.startsWith(prefix)));
  const hits: PrivateNameHit[] = [];
  for (let at = 0; at < scanned.length; at += BATCH) {
    const batch = scanned.slice(at, at + BATCH);
    const found = await Promise.all(
      batch.map(({ path, position }) => scanFile(root, path, position, names)),
    );
    hits.push(...found.flat());
  }
  return { names: names.length, files: scanned.length, hits };
}

const LOCATE = (position: number): string => `git ${LIST_FILES.join(' ')} | sed -n '${position}p'`;

/**
 * A push to main on Actions: the secret is set on this repository, so its absence there is a
 * misconfiguration, never a fork. A pull request (a fork's reads it empty) and a local run skip.
 */
export function namesRequired(env: Readonly<Record<string, string | undefined>>): boolean {
  return (
    env['GITHUB_ACTIONS'] === 'true' &&
    env['GITHUB_EVENT_NAME'] === 'push' &&
    env['GITHUB_REF'] === 'refs/heads/main'
  );
}

const UNSET_FINDING: Finding = {
  code: 'X_PRIVATE_NAMES_UNSET',
  at: '.github/workflows/ci.yml',
  cause: `a push to main ran with ${ENV_NAME} empty, so the private-name guard would scan nothing and pass; on main the secret must arrive`,
  fix: `gh secret set ULTIMATE_PRIVATE_NAMES   # an admin, pasting the off-tree list (one name per line) at its prompt; then re-run the workflow`,
};

export function privateNameFinding(hit: PrivateNameHit): Finding {
  const where =
    hit.file === undefined
      ? `tracked path ${hit.position} (${LOCATE(hit.position)})${hit.line === 0 ? '' : `, line ${hit.line}`}`
      : `${hit.file}:${hit.line}`;
  const subject = hit.line === 0 ? 'its path' : 'that line';
  return {
    code: 'X_PRIVATE_NAME',
    at: where,
    cause: `${where}: ${subject} carries entry ${hit.index} of ${ENV_NAME}, a private adopter name the public tree must not hold`,
    fix:
      hit.line === 0
        ? `${LOCATE(hit.position)}   # prints the path: git mv it to one without the name, then: bun run private-names --json`
        : `${hit.file === undefined ? LOCATE(hit.position) : `grep -n '' ${renderFixShellArg(hit.file, '<file>')} | sed -n '${String(hit.line)}p'`}   # at line ${hit.line}, replace the name with "one adopter" or an example.com fixture, keeping any figure; then: bun run private-names --json`,
  };
}

export function privateNameResult(scan: PrivateNameScan | undefined): ScriptResult {
  if (scan === undefined) return { ok: true, script: SCRIPT, summary: SKIP_NOTE, findings: [] };
  const findings = scan.hits.map(privateNameFinding);
  const checked = `private-names: checked ${scan.names} names across ${scan.files} files`;
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary: findings.length === 0 ? checked : `${checked}, ${findings.length} carry one`,
    findings,
    data: { names: scan.names, files: scan.files, hits: scan.hits.length },
  };
}

/** The verdict for one environment: the names it carries, scanned under `root`. */
export async function privateNameReport(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ScriptResult> {
  const names = namesFromEnv(env);
  if (names.length === 0 && namesRequired(env)) {
    return {
      ok: false,
      script: SCRIPT,
      summary: `private-names: ${ENV_NAME} is unset on a push to main`,
      findings: [UNSET_FINDING],
    };
  }
  return privateNameResult(await scanPrivateNames(root, names));
}

/**
 * The rule as a host check: `scripts/verify.ts` runs it on the gate's `boundaries` step. The
 * summary goes to stderr, so the gate's log says whether it scanned or skipped: a CI run's proof
 * that the secret arrived is the "checked" line there.
 */
export async function privateNameFindings(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
  log: (line: string) => void = (line) => {
    writeSync(2, `${line}\n`);
  },
): Promise<readonly Finding[]> {
  const result = await privateNameReport(root, env);
  log(result.summary);
  return result.findings ?? [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(await privateNameReport(repoRoot(), process.env), args.json);
}
