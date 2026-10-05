#!/usr/bin/env bun
// Enforce that every `docs/plans/**/status.yml` parses, and that its top-level `status` and each
// slice's `status` is one of the plan template's values.
//
// `status.yml` is the one machine-read file in a plan directory (`.claude/commands/planx.md`, the
// template): a tracker reading `done`, `finished` or nothing at all reads as a plan nobody can sort,
// and nothing stopped one being written but the comment beside the field.
//
//   bun run plan-status  ·  bun run scripts/plan-status.ts [--json]

// why: host-separator paths into the checkout; Bun ships no path API.
import { join } from 'node:path';
import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

const SCRIPT = 'plan-status';
const GLOB = 'docs/plans/**/status.yml';

/** The template's enum, verbatim from `.claude/commands/planx.md`, for a plan and for a slice. */
export const PLAN_STATUSES = [
  'not_started',
  'in_progress',
  'blocked',
  'complete',
  'superseded',
] as const;

const ALLOWED: ReadonlySet<string> = new Set(PLAN_STATUSES);
const ENUM = PLAN_STATUSES.join(' | ');

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** A value as a reader would write it back: a string quoted, anything else by its JSON. */
const shown = (value: unknown): string =>
  value === undefined ? 'nothing' : (JSON.stringify(value) ?? String(typeof value));

const invalid = (path: string, field: string, value: unknown): Finding => ({
  code: 'X_PLAN_STATUS_INVALID',
  cause: `${path} ${field} is ${shown(value)}, which is not one of the template's values (${ENUM})`,
  fix: `bun run plan-status --json   # after setting ${field} in ${path} to one of: ${ENUM}`,
  at: path,
});

/** Every finding one `status.yml` earns. Pure over its path and text, so a test passes both. */
export function statusFindings(path: string, text: string): readonly Finding[] {
  let doc: unknown;
  try {
    doc = Bun.YAML.parse(text);
  } catch {
    return [
      {
        code: 'X_PLAN_STATUS_INVALID',
        cause: `${path} is not valid YAML, so no tracker can read it`,
        fix: `bun run plan-status --json   # after repairing the YAML in ${path} until it parses`,
        at: path,
      },
    ];
  }
  if (!isRecord(doc)) return [invalid(path, 'status', undefined)];
  const findings: Finding[] = [];
  if (typeof doc['status'] !== 'string' || !ALLOWED.has(doc['status'])) {
    findings.push(invalid(path, 'status', doc['status']));
  }
  const slices = Array.isArray(doc['slices']) ? doc['slices'] : [];
  slices.forEach((slice: unknown, index) => {
    const row = isRecord(slice) ? slice : {};
    const name = typeof row['file'] === 'string' ? row['file'] : `#${String(index + 1)}`;
    if (typeof row['status'] !== 'string' || !ALLOWED.has(row['status'])) {
      findings.push(invalid(path, `slices[${name}].status`, row['status']));
    }
  });
  return findings;
}

/** Every `status.yml` under `docs/plans/`, sorted; none at all is unscanned, never a pass. */
export async function planStatusFindings(root: string): Promise<readonly Finding[]> {
  const paths = (await Array.fromAsync(new Bun.Glob(GLOB).scan({ cwd: root })))
    .map((path) => path.split('\\').join('/'))
    .sort();
  if (paths.length === 0) {
    return [
      {
        code: 'X_PLAN_STATUS_UNSCANNED',
        cause: `no file matched ${GLOB}, so no plan tracker was checked — a glob that matches nothing reads exactly like a clean tree`,
        fix: 'bun run scripts/plan-status.ts --json   # run from the repository root; if plans moved, edit GLOB in scripts/plan-status.ts',
        at: 'docs/plans/',
      },
    ];
  }
  const findings: Finding[] = [];
  for (const path of paths) {
    findings.push(...statusFindings(path, await Bun.file(join(root, path)).text()));
  }
  return findings;
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await planStatusFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: SCRIPT,
      summary:
        findings.length === 0
          ? `every plan status.yml holds a template status (${ENUM})`
          : `${String(findings.length)} plan status value(s) outside the template`,
      findings,
    },
    args.json,
  );
}
