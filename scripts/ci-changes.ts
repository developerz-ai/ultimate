#!/usr/bin/env bun
// Does this diff reach the heavy CI jobs at all? `heavy: false` only when every changed path is
// prose no such job reads — `wiki/`, `docs/` and root markdown — and true on any doubt: an empty or
// missing list, a quoted path, a path the allowlist does not name. Never red: a doubt is a full run.
//
//   bun run scripts/ci-changes.ts <file-of-paths> [--json]

import { parseScriptArgs } from './lib/args';
import { report } from './lib/log';

/**
 * Prose no heavy job reads. `windows`, `macos`, `scaffold-smoke`, `fault-drills`, `container` and
 * `compose-deploy` run code, scaffolds and images; a wiki page or a decision record changes none
 * of them. Markdown under `packages/`, `scripts/`, `docker/`, `examples/` or `dummy/` is NOT here:
 * a package's README ships in its tarball, and an app's docs are its build input. The gate still
 * reads all of it (`errors`, `manifest`, the doc guards) and runs on every diff.
 */
const PROSE = [
  /^wiki\/(?:[\w.-]+\/)*[\w-][\w.-]*\.md$/,
  /^docs\/(?:[\w.-]+\/)*[\w-][\w.-]*\.md$/,
  /^[\w-][\w.-]*\.md$/,
];

export interface ChangeVerdict {
  readonly heavy: boolean;
  /** The changed paths that are not proven prose: why `heavy` is true. */
  readonly code: readonly string[];
  readonly reason: string;
}

const isProse = (path: string): boolean =>
  !path.split('/').includes('..') && PROSE.some((pattern) => pattern.test(path));

export function classifyChanges(files: readonly string[]): ChangeVerdict {
  if (files.length === 0) {
    return { heavy: true, code: [], reason: 'no changed paths were read, so nothing is proven' };
  }
  const code = files.filter((path) => !isProse(path));
  return code.length === 0
    ? { heavy: false, code, reason: `${files.length} changed path(s), every one prose` }
    : { heavy: true, code, reason: `${code.length} of ${files.length} changed path(s) not prose` };
}

/** `git diff --name-only` output, one path a line; `undefined` (no file) is an empty list. */
export const parseChangedFiles = (text: string | undefined): readonly string[] =>
  (text ?? '')
    .split('\n')
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => line.trim() !== '');

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  const path = args.positionals[0];
  const file = path === undefined ? undefined : Bun.file(path);
  const text = file !== undefined && (await file.exists()) ? await file.text() : undefined;
  const verdict = classifyChanges(parseChangedFiles(text));
  report(
    {
      ok: true,
      script: 'ci-changes',
      summary: `heavy=${String(verdict.heavy)}: ${verdict.reason}`,
      data: verdict,
      lines: verdict.code.slice(0, 20),
    },
    args.json,
  );
}
