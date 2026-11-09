#!/usr/bin/env bun
// Enforce, on `x verify`'s `manifest` step, that every TypeScript subpath a package exports has its
// row in tsconfig.base.json's `paths`, pointing at the same file. An app resolves a subpath through
// its workspace symlink and the package's `exports`; the repo root resolves through `paths` alone,
// where `@ultimat3/*` maps `@ultimat3/jobs/adapter` to a directory that does not exist (TS2307).
//
//   bun run scripts/tsconfig-paths.ts [--json]

import { parseScriptArgs } from './lib/args';
import type { Finding } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';

export const TSCONFIG = 'tsconfig.base.json';

export interface SubpathExport {
  /** `@ultimat3/<pkg>/<subpath>`. */
  readonly specifier: string;
  /** Repo-relative, `./packages/<dir>/…`, as a `paths` row writes it. */
  readonly target: string;
}

export interface TsconfigPathGap {
  readonly kind: 'missing' | 'stale' | 'unscanned';
  readonly specifier: string;
  /** What the row should hold: the export's target, or empty for a row nothing exports. */
  readonly target: string;
}

/** A wildcard row maps a family (`@ultimat3/*`, `…/icons/*`), never one export: not this rule's. */
const isWildcard = (specifier: string): boolean => specifier.includes('*');

/** Pure over the exports and the `paths` object, so every case is a fixture. */
export function checkTsconfigPaths(
  exported: readonly SubpathExport[],
  paths: Readonly<Record<string, readonly string[]>>,
): readonly TsconfigPathGap[] {
  const gaps: TsconfigPathGap[] = [];
  const wanted = new Map(exported.map((one) => [one.specifier, one.target]));
  for (const [specifier, target] of wanted) {
    const row = paths[specifier];
    if (row === undefined) gaps.push({ kind: 'missing', specifier, target });
    else if (row.length !== 1 || row[0] !== target) gaps.push({ kind: 'stale', specifier, target });
  }
  for (const specifier of Object.keys(paths)) {
    if (isWildcard(specifier) || wanted.has(specifier)) continue;
    gaps.push({ kind: 'stale', specifier, target: '' });
  }
  return gaps;
}

const row = (gap: TsconfigPathGap): string => `"${gap.specifier}": ["${gap.target}"],`;

export function tsconfigPathFindingFor(gap: TsconfigPathGap): Finding {
  if (gap.kind === 'unscanned') {
    return {
      code: 'X_TSCONFIG_PATHS_UNSCANNED',
      cause: `no package.json under packages/ exports a TypeScript subpath, so ${TSCONFIG}'s paths were checked against nothing`,
      fix: 'bun run scripts/tsconfig-paths.ts --json   # from the repo root',
      at: TSCONFIG,
    };
  }
  if (gap.kind === 'missing') {
    return {
      code: 'X_TSCONFIG_PATH_MISSING',
      cause: `${gap.specifier} is a package subpath export with no row in ${TSCONFIG} paths, so the repo root resolves it through @ultimat3/* to a directory that does not exist (TS2307)`,
      fix: `${row(gap)}   // add to compilerOptions.paths in ${TSCONFIG}, above the "@ultimat3/*" row`,
      at: TSCONFIG,
    };
  }
  return {
    code: 'X_TSCONFIG_PATH_STALE',
    cause:
      gap.target === ''
        ? `${TSCONFIG} paths maps ${gap.specifier} and no package exports that subpath`
        : `${TSCONFIG} paths maps ${gap.specifier} to a file other than the one its package exports`,
    fix:
      gap.target === ''
        ? `bun run scripts/tsconfig-paths.ts --json   # then delete the "${gap.specifier}" row from compilerOptions.paths in ${TSCONFIG}`
        : `${row(gap)}   // the row to write in ${TSCONFIG}`,
    at: TSCONFIG,
  };
}

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Every string `.ts`/`.tsx` subpath export of every package, as a `paths` row would name it. */
export async function readSubpathExports(root: string): Promise<readonly SubpathExport[]> {
  const found: SubpathExport[] = [];
  for await (const path of new Bun.Glob('packages/*/package.json').scan({ cwd: root })) {
    const manifest: unknown = await Bun.file(`${root}/${path}`).json();
    if (!isRecord(manifest) || typeof manifest['name'] !== 'string') continue;
    const exports = manifest['exports'];
    if (!isRecord(exports)) continue;
    const dir = path.split(/[\\/]/)[1] ?? '';
    for (const [key, value] of Object.entries(exports)) {
      if (key === '.' || typeof value !== 'string' || !/\.tsx?$/.test(value)) continue;
      if (isWildcard(key)) continue;
      found.push({
        specifier: `${manifest['name']}${key.slice(1)}`,
        target: `./packages/${dir}/${value.replace(/^\.\//, '')}`,
      });
    }
  }
  return found.sort((a, b) => (a.specifier < b.specifier ? -1 : 1));
}

/** `compilerOptions.paths`, read through Bun's JSONC-tolerant loader. */
async function readPaths(root: string): Promise<Readonly<Record<string, readonly string[]>>> {
  const config: unknown = Bun.JSONC.parse(await Bun.file(`${root}/${TSCONFIG}`).text());
  const options = isRecord(config) ? config['compilerOptions'] : undefined;
  const paths = isRecord(options) ? options['paths'] : undefined;
  if (!isRecord(paths)) return {};
  const out: Record<string, readonly string[]> = {};
  for (const [key, value] of Object.entries(paths)) {
    out[key] = Array.isArray(value) ? value.filter((one) => typeof one === 'string') : [];
  }
  return out;
}

/** What this repo contributes to `x verify`'s `manifest` step. */
export async function tsconfigPathFindings(root: string): Promise<readonly Finding[]> {
  const exported = await readSubpathExports(root);
  if (exported.length === 0) {
    return [tsconfigPathFindingFor({ kind: 'unscanned', specifier: '', target: '' })];
  }
  return checkTsconfigPaths(exported, await readPaths(root)).map(tsconfigPathFindingFor);
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const findings = await tsconfigPathFindings(repoRoot());
  report(
    {
      ok: findings.length === 0,
      script: 'tsconfig-paths',
      summary:
        findings.length === 0
          ? `every package subpath export has its ${TSCONFIG} paths row`
          : `${findings.length} package subpath export(s) out of step with ${TSCONFIG} paths`,
      findings,
    },
    args.json,
  );
}
