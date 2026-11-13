#!/usr/bin/env bun
// Every publishable package's public surface — the main entry, every subpath export — hashed per
// exported symbol into `scripts/lib/public-api.lock.json`. A symbol whose declaration changed, or
// that is gone, with no `BREAKING —` changelog entry naming it is X_PUBLIC_API_BREAK_UNDECLARED.
// REPORT-ONLY this release: a warning in `data.warnings`, exit 0; red under `--strict` and on
// every branch `REFUSE_ON_BRANCHES` names. An additive change is recorded with `--write`.
//
//   bun run scripts/public-api.ts [--write] [--strict] [--json]

// why: the LEAF module, never the `@ultimat3/cli` barrel — the same import deprecation-window.ts makes.
import { quoteArg } from '../packages/cli/src/shell-quote';
import { flagBool, parseScriptArgs } from './lib/args';
import { targetBranch } from './lib/changelog-highlights';
import { loadChangelog } from './lib/changelog-store';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import type { ApiBreak, ApiDiff, ApiLock, ApiSnapshot } from './lib/public-api-breaks';
import {
  declaredBreak,
  diffApi,
  LOCK_PATH,
  nextLock,
  parseLock,
  renderLock,
} from './lib/public-api-breaks';
import type { ApiEntry, ApiPackage } from './lib/public-api-emit';
import { dtsPathOf, emitDeclarations, packageEntries } from './lib/public-api-emit';
import { symbolReader } from './lib/public-api-symbols';
import { repoRoot } from './lib/run';
import { listWorkspaces, publishOrder } from './lib/workspaces';

const SCRIPT = 'public-api';
export const BREAK_CODE = 'X_PUBLIC_API_BREAK_UNDECLARED';
export const UNSCANNED_CODE = 'X_PUBLIC_API_UNSCANNED';

/**
 * The branches a finding is red on. Empty while the rule is report-only (31.x, the release it
 * landed in); `['next']` is the one edit that makes it refuse there, `['next', 'main']` everywhere.
 */
export const REFUSE_ON_BRANCHES: readonly string[] = [];

export interface PublicApiOptions {
  /** The publishable packages and the tree's version; default `listWorkspaces()`. */
  readonly packages?: readonly ApiPackage[];
  readonly version?: string;
  /** The compiler; default this tree's `node_modules/.bin/tsc`. */
  readonly tsc?: string;
}

export interface PublicApiReport {
  readonly findings: readonly Finding[];
  readonly diff: ApiDiff;
  /** The lock `--write` would write; absent when the surface could not be read. */
  readonly next?: ApiLock;
  readonly symbols: number;
}

const unscanned = (cause: string, fix: string): PublicApiReport => ({
  findings: [{ code: UNSCANNED_CODE, cause, fix, at: LOCK_PATH }],
  diff: { breaks: [], added: [] },
  symbols: 0,
});

function breakFinding(one: ApiBreak, lock: ApiLock, version: string, source: string): Finding {
  const what =
    one.kind === 'removed'
      ? `no longer exports \`${one.name}\``
      : `exports \`${one.name}\` with a declaration other than the one ${LOCK_PATH} recorded at ${lock.version}`;
  return {
    code: BREAK_CODE,
    cause: `${one.specifier} ${what}, and no \`BREAKING —\` entry under CHANGELOG.md [Unreleased] or in docs/changelog/${version}.md names it — code that compiled against ${lock.version} may not compile now`,
    fix: `git diff ${quoteArg(`v${lock.version}`)} -- ${quoteArg(source)}   # revert the change to \`${one.name}\`, or declare it on next: a "- **BREAKING —** (#N) \`${one.name}\` …" line under ## [Unreleased] in CHANGELOG.md, then bun run scripts/public-api.ts --write --json`,
    at: source,
  };
}

async function readLock(root: string): Promise<ApiLock | string | undefined> {
  const file = Bun.file(`${root}/${LOCK_PATH}`);
  if (!(await file.exists())) return undefined;
  try {
    return parseLock(await file.json());
  } catch {
    return 'is not valid JSON';
  }
}

async function defaultPackages(root: string): Promise<{ packages: ApiPackage[]; version: string }> {
  const workspaces = publishOrder(await listWorkspaces(root)).filter((one) => !one.private);
  return { packages: [...workspaces], version: workspaces[0]?.version ?? '0.0.0' };
}

/** The tree's surface against the lock: every finding, the diff, and the next lock. */
export async function publicApiReport(
  root: string,
  options: PublicApiOptions = {},
): Promise<PublicApiReport> {
  const fallback = options.packages === undefined ? await defaultPackages(root) : undefined;
  const packages = options.packages ?? fallback?.packages ?? [];
  const version = options.version ?? fallback?.version ?? '0.0.0';
  const entries: ApiEntry[] = [];
  for (const pkg of packages) entries.push(...(await packageEntries(root, pkg)));
  if (entries.length === 0) {
    return unscanned(
      'no publishable package under packages/ exports a TypeScript entry, so no surface was read',
      'cd "$(git rev-parse --show-toplevel)" && bun run scripts/list-workspaces.ts --json',
    );
  }
  const emitted = await emitDeclarations(root, entries, options.tsc);
  if (!emitted.ok) {
    return unscanned(
      `the public surface could not be emitted: ${emitted.problem}`,
      'bun install && bun run scripts/public-api.ts --json',
    );
  }
  const read = symbolReader(emitted.tree);
  const tree: Record<string, Readonly<Record<string, string>>> = {};
  for (const entry of entries) tree[entry.specifier] = read(dtsPathOf(entry.source));
  const symbols = Object.values(tree).reduce((sum, names) => sum + Object.keys(names).length, 0);
  const lock = await readLock(root);
  if (typeof lock === 'string') {
    return unscanned(
      `${LOCK_PATH} ${lock}, so no change to the public surface can be judged`,
      'bun run scripts/public-api.ts --write --json',
    );
  }
  const baseline: ApiSnapshot = lock?.entries ?? tree;
  const diff = diffApi(baseline, tree);
  const changelog = await loadChangelog(root);
  const undeclared = diff.breaks.filter((one) => !declaredBreak(changelog, version, one.name));
  const sourceOf = new Map(entries.map((entry) => [entry.specifier, entry.source]));
  const findings: Finding[] =
    lock === undefined
      ? [
          {
            code: UNSCANNED_CODE,
            cause: `${LOCK_PATH} does not exist, so no change to the public surface can be judged`,
            fix: 'bun run scripts/public-api.ts --write --json',
            at: LOCK_PATH,
          },
        ]
      : undeclared.map((one) =>
          breakFinding(one, lock, version, sourceOf.get(one.specifier) ?? LOCK_PATH),
        );
  return { findings, diff, next: nextLock(lock, tree, version, undeclared), symbols };
}

/** Whether a finding is red: `--strict`, or a target branch `REFUSE_ON_BRANCHES` names. */
export const refuses = (strict: boolean, env: Readonly<Record<string, string | undefined>>) =>
  strict || REFUSE_ON_BRANCHES.includes(targetBranch(env) ?? '');

const warningLine = (finding: Finding): string =>
  `${finding.code} ${finding.cause} — fix: ${finding.fix}`;

/**
 * The `manifest` step's host rule. A host rule can only add findings, so while the rule is
 * report-only it answers none and prints its warnings on stderr, where the gate's log shows them.
 */
export async function publicApiFindings(
  root: string,
  env: Readonly<Record<string, string | undefined>> = Bun.env,
): Promise<readonly Finding[]> {
  const { findings } = await publicApiReport(root);
  if (refuses(false, env)) return findings;
  for (const finding of findings) process.stderr.write(`warning: ${warningLine(finding)}\n`);
  return [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2), {
    names: ['write', 'strict'],
    refuse: (unknown, flags) =>
      report(
        {
          ok: false,
          script: SCRIPT,
          summary: `refusing: unknown flag(s) ${unknown.map((name) => `--${name}`).join(', ')}`,
          findings: [
            {
              code: 'X_CLI_BAD_FLAG',
              cause: `${SCRIPT} takes --write, --strict and --json, and was given ${unknown.map((name) => `--${name}`).join(', ')}`,
              fix: 'bun run scripts/public-api.ts --json',
            },
          ],
        },
        flags.get('json') === true,
      ),
  });
  const root = repoRoot();
  const started = performance.now();
  const result = await publicApiReport(root);
  const write = flagBool(args, 'write');
  if (write && result.next !== undefined) {
    await Bun.write(`${root}/${LOCK_PATH}`, renderLock(result.next));
  }
  const red = refuses(flagBool(args, 'strict'), Bun.env);
  const ms = Math.round(performance.now() - started);
  const scanned = result.symbols > 0;
  report(
    {
      ok: (red ? result.findings.length === 0 : true) && (!write || result.next !== undefined),
      script: SCRIPT,
      summary:
        result.findings.length === 0
          ? `${result.symbols} exported symbols match ${LOCK_PATH}${result.diff.added.length > 0 ? ` (${result.diff.added.length} added${write ? ', recorded' : ': record them with --write'})` : ''} — ${ms} ms`
          : `${result.findings.length} public API finding(s)${red ? '' : ' — report-only, exit 0'}${scanned ? ` over ${result.symbols} symbols` : ''} — ${ms} ms`,
      findings: red ? result.findings : [],
      lines: red ? [] : result.findings.map((finding) => `  warning: ${warningLine(finding)}`),
      data: {
        mode: red ? 'refuse' : 'report',
        symbols: result.symbols,
        warnings: red ? [] : result.findings.map(warningLine),
        breaks: result.diff.breaks,
        added: result.diff.added,
        written: write && result.next !== undefined,
        ms,
      },
    },
    args.json,
  );
}
