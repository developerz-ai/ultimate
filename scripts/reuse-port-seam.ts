#!/usr/bin/env bun
// Enforce, as a build error, that Bun.serve's `reusePort` is spelled in ONE place: core's
// `sharedPortOption(env)` in `packages/core/src/shared-port.ts`. The option is only safe when a
// supervisor owns the port and the kernel balances it (Linux); set anywhere else, two unsupervised
// processes silently share a port, or a non-Linux host quietly runs one of them unreachable.
//
// WHAT IT REPORTS, in shipped source and both tracked apps (tests are fixtures, never reported):
// `reusePort` as a word in code (`{ reusePort: true }`), as a whole string (`opts['reusePort']`),
// or as a key inside a string (a scaffold template emitting `reusePort: true`). Comments and prose
// in a message (`Bun ignores reusePort`) are never reported.
//
//   bun run reuse-port-seam  ·  bun run scripts/reuse-port-seam.ts [--json]

import { quoteArg } from '../packages/cli/src/shell-quote';
import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import { APP_ROOTS } from './boundaries';
import { parseScriptArgs } from './lib/args';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'reuse-port-seam';
const THIS_FILE = 'scripts/reuse-port-seam.ts';

/** The one module that may spell the option. */
export const SHARED_PORT_SEAM = 'packages/core/src/shared-port.ts';

const NAME = 'reusePort';
const WORD = new RegExp(`\\b${NAME}\\b`, 'g');
const QUOTE = /^['"`]$/;

export interface SourceText {
  readonly path: string;
  readonly source: string;
}

/**
 * Whether the word at `at` sets the option. In code, always — the mask keeps code and blanks a
 * string's contents. Inside a string, only as a whole string (a computed key) or followed by `:`
 * (an options object a template writes); a message naming the option is prose.
 */
const setsOption = (text: string, masked: string, at: number): boolean => {
  if (masked[at] !== ' ') return true;
  const before = text[at - 1] ?? '';
  const after = text[at + NAME.length] ?? '';
  return (before === after && QUOTE.test(before)) || /^\s*:/.test(text.slice(at + NAME.length));
};

/** Every line, outside the seam and tests, that sets `reusePort` in code or a string. */
export function reusePortSites(file: string, source: string): readonly number[] {
  if (file === SHARED_PORT_SEAM || isTestPath(file)) return [];
  const text = stripComments(source);
  const masked = maskLiterals(source);
  return [...text.matchAll(WORD)]
    .filter((match) => setsOption(text, masked, match.index))
    .map((match) => lineOf(text, match.index));
}

const outside = (file: string, line: number): Finding => ({
  code: 'X_REUSEPORT_OUTSIDE_SEAM',
  at: `${file}:${String(line)}`,
  cause: `${file}:${String(line)} sets reusePort directly; only ${SHARED_PORT_SEAM} may, because the option is safe only under a supervisor on Linux`,
  fix: `grep -n reusePort ${quoteArg(file)}   # at line ${String(line)}, replace the option with ...sharedPortOption(env) from '@ultimat3/core', then: bun run reuse-port-seam --json`,
});

export function reusePortResult(files: readonly SourceText[]): ScriptResult {
  const findings: Finding[] = files.some((file) => file.path === SHARED_PORT_SEAM)
    ? files.flatMap((file) =>
        reusePortSites(file.path, file.source).map((line) => outside(file.path, line)),
      )
    : [
        {
          code: 'X_REUSEPORT_OUTSIDE_SEAM',
          at: THIS_FILE,
          cause: `${SHARED_PORT_SEAM} was not among the files scanned, so the exemption names nothing and a clean run proves nothing`,
          fix: `grep -n 'SHARED_PORT_SEAM' ${THIS_FILE}   # point it at the module that declares sharedPortOption, then: bun run reuse-port-seam --json`,
        },
      ];
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${String(files.length)} files, reusePort spelled only by ${SHARED_PORT_SEAM}`
        : `${String(findings.length)} reusePort site(s) outside the seam`,
    findings,
    data: { files: files.length },
  };
}

const GLOBS = ['packages/*/src/**/*.{ts,tsx}', `${APP_ROOTS}/*/**/*.{ts,tsx}`];
const NOT_SOURCE = /(?:^|\/)(?:node_modules|dist|\.x)\//;

export async function readReusePortSources(root: string): Promise<readonly SourceText[]> {
  const files: SourceText[] = [];
  for (const glob of GLOBS) {
    for await (const path of new Bun.Glob(glob).scan({ cwd: root })) {
      const posix = path.split('\\').join('/');
      if (NOT_SOURCE.test(posix) || isTestPath(posix)) continue;
      files.push({ path: posix, source: await Bun.file(`${root}/${posix}`).text() });
    }
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(reusePortResult(await readReusePortSources(repoRoot())), args.json);
}
