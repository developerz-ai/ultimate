#!/usr/bin/env bun
// Enforce, as a build error, that the public tree names nothing private: no tracked file or path
// carries the internal setup mode's name or an entry of the ULTIMATE_PRIVATE_NAMES or
// ULTIMATE_PRIVATE_REPOS secrets (an adopter, or a private repository a reader cannot open). A
// finding prints the file:line and what it matched by class and 1-based index, never the value.
//
// WHY THE LIST IS A SECRET. A committed list, plain or hashed, publishes the names it guards (a
// short name hashes back by brute force). CI logs are public, and Actions masks a secret's whole
// value, not each line of it, so the output carries indices only. The setup mode is the one value
// the guard knows itself, built from parts so this file never carries it whole: it is already in
// the history, and the guard buys that the tree stops carrying it again.
//
// THE SCAN PROVES ITSELF. It reads `git ls-files` (cached, plus untracked files git does not
// ignore, so a new page is caught before its commit), counts the files it read, and refuses a run
// that did not read this file: a scan of the wrong tree, or of nothing, is never a green. A root
// that is no git tree and holds no copy of this file (a gate test's planted directory) is a skip
// that says so: there is no public tree there. `.dz/` is the platform's own and is not read. CHANGELOG.md, docs/changelog/,
// docs/history/ and docs/plans/ are records: an adopter name there stands, but the setup mode and a
// private repository do not.
//
// UNSET SKIPS THE NAMES, and says so; the setup mode is still checked. A fork's pull request cannot
// read the secret and receives an empty string. With ULTIMATE_PRIVATE_NAMES_REQUIRED=1, which
// ci.yml sets beside the secret on the step that runs `boundaries` on a push to main, an empty
// names secret is red, since the names would otherwise pass forever unchecked; the repositories
// secret is optional there too. Never inferred from the event: a unit job on the same push runs
// this guard with no secret and must skip. Matchers: `private-names-match.ts`.
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
import type { DenyList, LineHit } from './private-names-match';
import {
  denyListFromEnv,
  ENV_NAME,
  entriesOf,
  lineHit,
  REPOS_ENV,
  repositoryMatchers,
} from './private-names-match';

const SCRIPT = 'private-names';

/** This file, repo-relative: the scan must have read it, or it read the wrong tree. */
export const SELF = 'scripts/private-names.ts';

/** Set to `1` on the one CI step that must scan: there an empty secret is red, not a skip. */
export const REQUIRED_ENV = 'ULTIMATE_PRIVATE_NAMES_REQUIRED';

export const SKIP_NOTE = `skipped names, ${ENV_NAME} is unset`;

/** Records whose history stands: an adopter name in them is never rewritten. */
const RECORDS = ['CHANGELOG.md', 'docs/changelog/', 'docs/history/', 'docs/plans/'];

/** The platform's own directory, rewritten whole by it: out of this repository's hands. */
const PLATFORM_OWNED = ['.dz/'];

export interface PrivateNameHit {
  /** The tracked file, or `undefined` when its own path carries a value and may not be printed. */
  readonly file: string | undefined;
  /** Its 1-based position in `git ls-files`, which locates a file whose path cannot be printed. */
  readonly position: number;
  /** 0 for a hit in the path itself. */
  readonly line: number;
  readonly hit: LineHit;
}

export interface PrivateNameScan {
  readonly names: number;
  readonly repositories: number;
  readonly files: number;
  readonly hits: readonly PrivateNameHit[];
}

const isBinary = (bytes: Uint8Array): boolean => bytes.subarray(0, 8000).includes(0);

/** Files read at once: enough to keep the disk busy, few enough to hold no tree in memory. */
const BATCH = 64;

interface FileScan {
  readonly hits: readonly PrivateNameHit[];
  /** Whether its text was read: false for a binary file or one the work tree deleted. */
  readonly read: boolean;
}

/** One listed file's hits: its path, then each line. */
async function scanFile(
  root: string,
  path: string,
  position: number,
  names: readonly string[],
  repositories: readonly RegExp[],
): Promise<FileScan> {
  const hits: PrivateNameHit[] = [];
  const own = RECORDS.some((prefix) => path.startsWith(prefix)) ? [] : names;
  const pathHit = lineHit(path, own, repositories);
  const file = pathHit === undefined ? path : undefined;
  if (pathHit !== undefined) hits.push({ file, position, line: 0, hit: pathHit });
  const handle = Bun.file(`${root}/${path}`);
  // A path the index holds but the work tree deleted has no lines to read.
  if (!(await handle.exists())) return { hits, read: false };
  const bytes = await handle.bytes();
  if (isBinary(bytes)) return { hits, read: false };
  for (const [line, text] of new TextDecoder().decode(bytes).split('\n').entries()) {
    const hit = lineHit(text, own, repositories);
    if (hit !== undefined) hits.push({ file, position, line: line + 1, hit });
  }
  return { hits, read: true };
}

/** Tracked files and the untracked ones git does not ignore: what the next commit can carry. */
const LIST_FILES = ['ls-files', '--cached', '--others', '--exclude-standard'] as const;

const refuse = (cause: string): ScriptError =>
  new ScriptError({
    code: 'X_PRIVATE_NAME',
    cause,
    fix: 'git ls-files scripts/private-names.ts   # run from the repository root, then: bun run private-names --json',
  });

/** The summary of a root that is no repository and holds no guard: nothing to vouch for. */
export const NOT_A_TREE = `private-names: skipped, not a git work tree and no ${SELF} in it`;

/**
 * Every listed file outside the platform's own; the setup mode is checked even with no secret.
 * `undefined` for a root git cannot list that does not hold this guard either: a directory a
 * gate test planted, not a public tree. A root that holds the guard and cannot be listed is
 * refused, so this repository can never scan nothing and pass.
 */
export async function scanPrivateNames(
  root: string,
  deny: DenyList,
): Promise<PrivateNameScan | undefined> {
  const listed = Bun.spawnSync(['git', ...LIST_FILES, '-z'], { cwd: root, timeout: 30_000 });
  if (listed.exitCode !== 0) {
    if (!(await Bun.file(`${root}/${SELF}`).exists())) return undefined;
    throw refuse(
      `git ls-files failed in ${root}, so no tracked file was read and a clean run would prove nothing`,
    );
  }
  const scanned = listed.stdout
    .toString()
    .split('\0')
    .map((path, at) => ({ path, position: at + 1 }))
    .filter(({ path }) => path.length > 0 && !PLATFORM_OWNED.some((dir) => path.startsWith(dir)));
  const repositories = repositoryMatchers(deny.repositories);
  const hits: PrivateNameHit[] = [];
  let readSelf = false;
  for (let at = 0; at < scanned.length; at += BATCH) {
    const batch = scanned.slice(at, at + BATCH);
    const found = await Promise.all(
      batch.map(({ path, position }) => scanFile(root, path, position, deny.names, repositories)),
    );
    for (const [index, scan] of found.entries()) {
      if (batch[index]?.path === SELF && scan.read) readSelf = true;
      hits.push(...scan.hits);
    }
  }
  if (!readSelf) {
    throw refuse(
      `the scan of ${root} never read ${SELF}, so it read some other tree (or none) and a clean run would prove nothing`,
    );
  }
  return {
    names: deny.names.length,
    repositories: deny.repositories.length,
    files: scanned.length,
    hits,
  };
}

const LOCATE = (position: number): string => `git ${LIST_FILES.join(' ')} | sed -n '${position}p'`;

/**
 * The step that set REQUIRED_ENV to `1` handed the secret in beside it, so its absence there is a
 * misconfiguration. Anything else, the event included, is a skip: a unit job reaches this guard on a
 * push to main with no secret, and a fork's pull request reads the secret empty.
 */
export function namesRequired(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[REQUIRED_ENV] === '1';
}

const UNSET_FINDING: Finding = {
  code: 'X_PRIVATE_NAMES_UNSET',
  at: '.github/workflows/ci.yml',
  cause: `${REQUIRED_ENV}=1 and ${ENV_NAME} is empty, so the private-name guard would scan nothing and pass; the step that requires the names must receive the secret`,
  fix: `gh secret set ULTIMATE_PRIVATE_NAMES   # an admin, pasting the off-tree list (one name per line) at its prompt; then re-run the workflow`,
};

/** What the matched value is, by class and index: never the value itself. */
function carries(hit: LineHit): string {
  if (hit.kind === 'setup-mode') {
    return `the internal setup mode's name (built from parts in ${SELF}), which says how our own machines are laid out`;
  }
  return hit.kind === 'repository'
    ? `repository entry ${hit.index} of ${ENV_NAME} then ${REPOS_ENV} (\`/\` entries, in that order), a private repository a reader cannot open`
    : `entry ${hit.index} of ${ENV_NAME}, a private adopter name the public tree must not hold`;
}

const REWRITE: Record<LineHit['kind'], string> = {
  'setup-mode': 'say what the machine is ("a bare VM") without the mode\'s name',
  repository: 'drop the reference, or say "the infrastructure repository" without its name',
  name: 'replace the name with "one adopter" or an example.com fixture, keeping any figure',
};

export function privateNameFinding(found: PrivateNameHit): Finding {
  const where =
    found.file === undefined
      ? `tracked path ${found.position} (${LOCATE(found.position)})${found.line === 0 ? '' : `, line ${found.line}`}`
      : `${found.file}:${found.line}`;
  const subject = found.line === 0 ? 'its path' : 'that line';
  const show =
    found.file === undefined
      ? LOCATE(found.position)
      : `grep -n '' ${renderFixShellArg(found.file, '<file>')} | sed -n '${String(found.line)}p'`;
  return {
    code: 'X_PRIVATE_NAME',
    at: where,
    cause: `${where}: ${subject} carries ${carries(found.hit)}`,
    fix:
      found.line === 0
        ? `${LOCATE(found.position)}   # prints the path: git mv it to one without the value, then: bun run private-names --json`
        : `${show}   # at line ${found.line}, ${REWRITE[found.hit.kind]}; then: bun run private-names --json`,
  };
}

export function privateNameResult(scan: PrivateNameScan | undefined): ScriptResult {
  if (scan === undefined) return { ok: true, script: SCRIPT, summary: NOT_A_TREE, findings: [] };
  const findings = scan.hits.map(privateNameFinding);
  const lists = [
    ...(scan.names === 0 ? [] : [`${scan.names} names`]),
    ...(scan.repositories === 0 ? [] : [`${scan.repositories} repositories`]),
  ];
  const what = lists.length === 0 ? 'the setup mode' : lists.join(' and ');
  const skipped = scan.names === 0 ? `; ${SKIP_NOTE}` : '';
  const checked = `private-names: checked ${what} across ${scan.files} files${skipped}`;
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary: findings.length === 0 ? checked : `${checked}, ${findings.length} carry one`,
    findings,
    data: {
      names: scan.names,
      repositories: scan.repositories,
      files: scan.files,
      hits: scan.hits.length,
    },
  };
}

/** The verdict for one environment: the deny-list it carries, scanned under `root`. */
export async function privateNameReport(
  root: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<ScriptResult> {
  // The flag keys on the names secret alone: the repositories one is optional everywhere.
  if (entriesOf(env[ENV_NAME]).length === 0 && namesRequired(env)) {
    return {
      ok: false,
      script: SCRIPT,
      summary: `private-names: ${ENV_NAME} is unset and ${REQUIRED_ENV}=1`,
      findings: [UNSET_FINDING],
    };
  }
  return privateNameResult(await scanPrivateNames(root, denyListFromEnv(env)));
}

/**
 * The rule as a host check: `scripts/verify.ts` runs it on the gate's `boundaries` step. The
 * summary goes to stderr, so the gate's log says what it scanned: a CI run's proof that the secret
 * arrived is the "checked N names" line there.
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
