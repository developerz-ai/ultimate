#!/usr/bin/env bun
// Refuse a test that creates a database under a fixed name — every `create database` a suite runs
// must be named by `probeDatabaseName()` from `@ultimat3/core`.
//
// THE DEFECT THIS EXISTS FOR (#705). Eleven live and contract suites created and dropped
// `x_jobs_claim_live`, `x_purge_probe` and the like: two runs against one server — a dev re-run
// beside a gate, two checkouts sharing `docker/test-services` — and the first `afterAll` dropped the
// database from under the other's still-running tests. CI runs the live suites in one job, so it
// never saw it. Pid alone is not enough either: two containers can run the same pid.
//
// WHAT IT CHECKS, over the `tests` corpus (comments stripped): the name after `create database`.
// A literal is refused outright. A binding — `${DB}`, `"${DB}"`, `${sql(DB)}`, `' … ' + DB` — is
// refused when the file declares it with an initialiser that neither calls `probeDatabaseName(`
// nor aliases a binding that does. A line that ASSERTS on SQL the code under test generated
// (`expect(`, `toContain(`, `startsWith(` …) is a read, never a create.
//
// BLIND SPOTS, counted rather than passed: a name arriving as a parameter or an import, a member
// expression (`${names.probe}`), or any other shape after the keyword is UNJUDGED — reported in
// the summary and `data.unjudged`, never summed into "named by probeDatabaseName". This rule's own
// suite pins the tree's unjudged list at empty, so a new one is a decision made in that file.
//
//   bun run probe-databases  ·  bun run scripts/probe-databases.ts [--json]

import { stripComments } from '../packages/core/src/source-mask';
import { parseScriptArgs } from './lib/args';
import type { CorpusFile } from './lib/corpus';
import { corpus } from './lib/corpus';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'probe-databases';

/** This rule's own suite SPELLS the shapes it refuses, as fixtures inside template literals. */
const FIXTURE_FILES: ReadonlySet<string> = new Set(['scripts/probe-databases.test.ts']);

/** Where a statement starts; what follows the keyword is read by `nameSlot`. */
const CREATE = /create\s+database\b/gi;

const IDENT = '[A-Za-z_$][\\w$]*';
/** `${DB}`, `"${DB}"` and the helper-wrapped `${sql(DB)}`: the binding is the innermost name. */
const INTERPOLATED = new RegExp(
  `^\\s+"?\\$\\{\\s*(?:[\\w$.]+\\s*\\(\\s*)?(${IDENT})\\s*\\)?\\s*\\}`,
);
/** `'create database ' + DB` and `'create database "' + DB + '"'`: the binding after the plus. */
const CONCATENATED = new RegExp(`^\\s*"?\\s*['"\`]\\s*\\+\\s*(${IDENT})`);
/** A name written into the statement itself, quoted or bare. */
const LITERAL = /^\s+"?([A-Za-z_][\w$]*)/;

/**
 * A line comparing generated SQL against an expectation reads a statement, and a test TITLE names
 * one (`test('… via CREATE DATABASE … TEMPLATE', …)`); neither creates anything.
 */
const ASSERTION =
  /\b(?:expect|toContain|toBe|toEqual|toMatch|toHaveBeenCalledWith|startsWith|endsWith|includes|test|it|describe)(?:\.\w+)?\s*\(/;

export interface ProbeDatabaseSite {
  readonly file: string;
  readonly line: number;
}

export interface FixedProbeDatabase extends ProbeDatabaseSite {
  /** The binding or literal the statement names. */
  readonly name: string;
  /** True when the name is written into the statement itself, so there is no binding to rename. */
  readonly literal: boolean;
}

/** `const NAME = <init>;` — the initialiser, or `undefined` when the file does not declare it. */
function initialiserOf(source: string, name: string): string | undefined {
  const declared = new RegExp(
    `(?:const|let|var)\\s+${RegExp.escape(name)}\\s*(?::[^=\\n]+)?=\\s*([^;]+);`,
  ).exec(source);
  return declared?.[1];
}

type Verdict = 'probe' | 'fixed' | 'unknown';

/**
 * What a binding holds: a `probeDatabaseName(` call, an ALIAS of a binding that does (followed a
 * few hops, never in a cycle), or anything else, which is fixed. Undeclared in the file — a
 * parameter, an import — is `unknown`.
 */
function verdictOf(source: string, name: string, hops = 0): Verdict {
  const init = initialiserOf(source, name);
  if (init === undefined || hops > 4) return 'unknown';
  if (init.includes('probeDatabaseName(')) return 'probe';
  const alias = /^\s*([A-Za-z_$][\w$]*)\s*$/.exec(init)?.[1];
  return alias === undefined ? 'fixed' : verdictOf(source, alias, hops + 1);
}

export interface ProbeDatabaseScan {
  readonly creates: number;
  readonly fixed: readonly FixedProbeDatabase[];
  /** Creates whose name the rule cannot follow: a parameter, an import, an unrecognised shape. */
  readonly unjudged: readonly ProbeDatabaseSite[];
}

function scan(file: string, stripped: string): ProbeDatabaseScan {
  const lines = stripped.split('\n');
  const fixed: FixedProbeDatabase[] = [];
  const unjudged: ProbeDatabaseSite[] = [];
  let creates = 0;
  for (const match of stripped.matchAll(CREATE)) {
    const line = stripped.slice(0, match.index).split('\n').length;
    if (ASSERTION.test(lines[line - 1] ?? '')) continue;
    creates += 1;
    const rest = stripped.slice(match.index + match[0].length, match.index + match[0].length + 160);
    const binding = INTERPOLATED.exec(rest)?.[1] ?? CONCATENATED.exec(rest)?.[1];
    if (binding === undefined) {
      const literal = LITERAL.exec(rest)?.[1];
      if (literal === undefined) unjudged.push({ file, line });
      else fixed.push({ file, line, name: literal, literal: true });
      continue;
    }
    const verdict = verdictOf(stripped, binding);
    if (verdict === 'fixed') fixed.push({ file, line, name: binding, literal: false });
    else if (verdict === 'unknown') unjudged.push({ file, line });
  }
  return { creates, fixed, unjudged };
}

/** One file's fixed names, from its source as written. */
export const fixedProbeDatabases = (file: string, source: string): readonly FixedProbeDatabase[] =>
  scan(file, stripComments(source)).fixed;

/** The whole corpus: how many creates were read, which name a fixed database, which went unread. */
export function probeDatabaseSites(files: readonly CorpusFile[]): ProbeDatabaseScan {
  let creates = 0;
  const fixed: FixedProbeDatabase[] = [];
  const unjudged: ProbeDatabaseSite[] = [];
  for (const one of files) {
    if (FIXTURE_FILES.has(one.path)) continue;
    const found = scan(one.path, one.stripped);
    creates += found.creates;
    fixed.push(...found.fixed);
    unjudged.push(...found.unjudged);
  }
  return { creates, fixed, unjudged };
}

/** The read the runner does, by root: what `corpus-unscanned.test.ts` holds to refusing. */
export const probeDatabaseScan = async (root: string): Promise<ProbeDatabaseScan> =>
  probeDatabaseSites(await corpus(root, 'tests'));

export const probeDatabaseFindings = (fixed: readonly FixedProbeDatabase[]): readonly Finding[] =>
  fixed.map((one) => ({
    code: 'X_PROBE_DATABASE_FIXED',
    cause: `${one.file}:${String(one.line)} creates a database named by ${one.literal ? `the literal ${one.name}` : one.name}, which is the same on every run — two runs against one server drop each other's database mid-suite`,
    fix: `const ${one.literal ? 'PROBE_DB' : one.name} = probeDatabaseName('x_<suite>');   # in ${one.file}, with import { probeDatabaseName } from '@ultimat3/core'; then: bun run probe-databases`,
    at: `${one.file}:${String(one.line)}`,
  }));

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const { creates, fixed, unjudged } = await probeDatabaseScan(repoRoot());
  const named = creates - fixed.length - unjudged.length;
  const findings = probeDatabaseFindings(fixed);
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `${String(creates)} database(s) created by tests: ${String(named)} named by probeDatabaseName, ${String(unjudged.length)} whose name this rule cannot follow (data.unjudged)`
          : `${String(findings.length)} test database(s) created under a fixed name`,
      findings,
      data: { creates, named, fixed: fixed.length, unjudged },
    },
    args.json,
  );
}
