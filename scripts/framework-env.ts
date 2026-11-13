#!/usr/bin/env bun
// Enforce, as a build error, that every environment name shipped framework source reads by literal
// is in `FRAMEWORK_ENV` (`packages/core/src/framework-env.ts`), and that the list names nothing the
// source no longer mentions. `x doctor` judges an app's own names against that list.
//   bun run scripts/framework-env.ts [--json]

import { FRAMEWORK_ENV, frameworkEnvEntry } from '../packages/core/src/framework-env';
import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'framework-env';
export const REGISTRY_FILE = 'packages/core/src/framework-env.ts';

export interface EnvRead {
  readonly path: string;
  readonly line: number;
  /** The name read, or a template's static head (`OTEL_` from `` env[`OTEL_${x}`] ``). */
  readonly name: string;
  readonly prefix: boolean;
}

/**
 * `process.env.X`, `Bun.env['X']`, `ctx.env["X"]`, `` env[`X_${y}`] `` — any receiver ending in
 * `env`, read in the MASKED text so a `process.env.X` quoted inside a `fix:` string or a comment is
 * not a read. The name itself is taken from the comment-stripped text at the same offsets.
 */
const READ = /\benv(?:\?\.)?(?:\[\s*(['"`])|\.([A-Z][A-Z0-9_]*)\b)/g;
const NAME = /^([A-Z][A-Z0-9_]*)(['"`]|\$\{)/;

/** Fixtures and harness text are not the framework reading anything. */
const NOT_SHIPPED = /(?:-fixture|\.d)\.tsx?$|\/fixtures?\//;

export function envReads(path: string, masked: string, stripped: string): readonly EnvRead[] {
  const reads: EnvRead[] = [];
  for (const match of masked.matchAll(READ)) {
    const line = lineOf(masked, match.index);
    if (match[2] !== undefined) {
      reads.push({ path, line, name: match[2], prefix: false });
      continue;
    }
    const open = match.index + match[0].length;
    const named = NAME.exec(stripped.slice(open, open + 80));
    if (named === null) continue;
    const prefix = named[2] === '${';
    if (named[1] !== undefined) reads.push({ path, line, name: named[1], prefix });
  }
  return reads;
}

const registered = (read: EnvRead): boolean => {
  const entry = frameworkEnvEntry(read.name);
  if (entry === undefined) return false;
  // A template's head is only covered by a registered PREFIX it falls under, never by one name.
  return !read.prefix || entry.prefix === true;
};

export function unregisteredFinding(read: EnvRead): Finding {
  return {
    code: 'X_FRAMEWORK_ENV_UNREGISTERED',
    at: `${read.path}:${read.line}`,
    cause: `${read.path}:${read.line} reads ${read.name}${read.prefix ? '*' : ''} from the environment and ${REGISTRY_FILE} does not list it, so x doctor cannot tell an app that its own ${read.name} collides with the framework's`,
    fix: `{ name: '${read.name}', owner: '<package>', use: '<contract|switch|internal|host>' }   # an entry of FRAMEWORK_ENV in ${REGISTRY_FILE}, beside its owning package's; then: bun run scripts/framework-env.ts --json`,
  };
}

export function staleFinding(name: string, line = 1): Finding {
  return {
    code: 'X_FRAMEWORK_ENV_STALE',
    at: REGISTRY_FILE,
    cause: `FRAMEWORK_ENV lists ${name} and no shipped file under packages/*/src spells it, so the list claims a read that no longer happens`,
    fix: `edit ${REGISTRY_FILE}:${line} — remove ${name} from FRAMEWORK_ENV; then: bun run scripts/framework-env.ts --json`,
  };
}

export interface SourceFile {
  readonly path: string;
  readonly masked: string;
  readonly stripped: string;
}

export function frameworkEnvFindings(files: readonly SourceFile[]): readonly Finding[] {
  const shipped = files.filter((file) => !NOT_SHIPPED.test(file.path));
  const reads = shipped.flatMap((file) => envReads(file.path, file.masked, file.stripped));
  const findings = reads.filter((read) => !registered(read)).map(unregisteredFinding);
  // Stale: a registered name no shipped file spells at all, as a read or as a constant's value.
  const spelled = shipped
    .filter((file) => file.path !== REGISTRY_FILE)
    .map((file) => file.stripped)
    .join('\n');
  const registry = files.find((file) => file.path === REGISTRY_FILE)?.stripped ?? '';
  for (const entry of FRAMEWORK_ENV) {
    if (spelled.includes(entry.name)) continue;
    const at = registry.indexOf(`'${entry.name}'`);
    findings.push(staleFinding(entry.name, at < 0 ? 1 : lineOf(registry, at)));
  }
  return findings;
}

export const frameworkEnvResult = (findings: readonly Finding[], files: number): ScriptResult => ({
  ok: findings.length === 0,
  script: SCRIPT,
  summary:
    findings.length === 0
      ? `${files} shipped files, every literal env read listed in ${REGISTRY_FILE}`
      : `${findings.length} framework env finding(s)`,
  findings,
});

/** What this rule contributes to `x verify`, through its own test file. */
export async function frameworkEnvCheck(root: string): Promise<ScriptResult> {
  const files = await corpus(root, 'shipped');
  return frameworkEnvResult(frameworkEnvFindings(files), files.length);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(await frameworkEnvCheck(repoRoot()), args.json);
}
