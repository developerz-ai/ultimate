// What a finished `x test` run says beyond its exit code: which files failed, read out of bun's own
// per-file headers, and why a run in which every test skipped itself is not a pass. Split from
// `test-shards.ts`, which spends the files; this file only reads what came back.

import { ERROR_DOCS_URL } from '@ultimat3/core';
import { TEST_SERVICE_ENV, TEST_SERVICES_START } from '@ultimat3/testing';
import type { Finding } from './output';
import { quoteArg } from './shell-quote';

/** Bun prints `<path>:` above a file's own lines, and only for a file that printed something. */
const HEADER = /^(\S.*):$/;
/** What makes a file's section a failure: a failed test, or an error outside any test. */
const FAILED = /^\(fail\) |^# Unhandled error/;

const normal = (path: string): string => path.split('\\').join('/').replace(/^\.\//, '');

/**
 * The run's files whose section in bun's output holds a failure, in the order bun printed them.
 * A header naming no file of the run is ignored, so a log line ending in `:` is never a file.
 */
export function failingFiles(output: string, files: readonly string[]): readonly string[] {
  const known = new Set(files.map(normal));
  const failing: string[] = [];
  let current: string | undefined;
  for (const line of output.split('\n')) {
    const header = HEADER.exec(line.trimEnd())?.[1];
    if (header !== undefined && known.has(normal(header))) {
      current = normal(header);
      continue;
    }
    if (current !== undefined && FAILED.test(line) && !failing.includes(current)) {
      failing.push(current);
    }
  }
  return failing;
}

type Env = Readonly<Record<string, string | undefined>>;

/** The service variables the children ran without: a test that `needs` one skips over it. */
const unsetServices = (env: Env): readonly string[] =>
  Object.values(TEST_SERVICE_ENV).filter((key) => (env[key]?.trim() ?? '') === '');

const SHOWN_FILES = 3;

/**
 * A run whose every test skipped itself executed nothing, and `bun test` still exits 0 over it —
 * so "passed" would be the one answer that is certainly wrong. `X_TEST_FAILED`: the type ran no
 * check. The cause names what the children lacked; the fix starts it, or shows each skip's
 * condition when nothing the framework knows of was missing.
 */
export function allSkippedFinding(input: {
  readonly type?: string;
  readonly skipped: number;
  readonly files: readonly string[];
  /** The environment the `bun test` children saw. */
  readonly env: Env;
  /** `reproduceWords`: the selection's words after `x`, every selector kept, quoted here. */
  readonly rerun: readonly string[];
}): Finding {
  const missing = unsetServices(input.env);
  const label = input.type ?? 'test';
  const why =
    missing.length === 0
      ? 'each skip is its own condition in the file (a skipIf, a test.skip, a needs: whose service is unset)'
      : `the run's environment leaves ${missing.join(', ')} unset, and a test that needs that service skips without it`;
  const shown = input.files.slice(0, SHOWN_FILES).map(quoteArg).join(' ');
  return {
    code: 'X_TEST_FAILED',
    cause: `${label} run executed 0 of ${input.skipped} test(s): every one skipped itself, so nothing was checked — ${why}`,
    fix:
      missing.length === 0
        ? `grep -nE 'skip|needs:' ${shown}   # set what each skip waits for, then: x ${quoteArg(input.rerun)}`
        : // The reproduce line, whole: `--affected`, `--sample` and a passthrough decide the
          // selection, and a rebuilt `x test <type> --filter` reran a broader one.
          `${TEST_SERVICES_START} && x ${quoteArg(input.rerun)}   # this selection, now with the services`,
    docs: ERROR_DOCS_URL,
  };
}
