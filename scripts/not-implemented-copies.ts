#!/usr/bin/env bun
// Refuse a constructor of `X_NOT_IMPLEMENTED` anywhere but `@ultimat3/core`, which ships the one
// class, `NotImplementedError`. Ten packages each grew a `(feature, fix)` wrapper of their own with
// ten cause sentences for one fault; deleting them is not enough unless an eleventh is a build
// error. A call site writes `fix:` itself, so the errors step still reads every fix line.
//   bun run scripts/not-implemented-copies.ts [--json]

import { scanCodeFixSites } from '../packages/cli/src/ts-scan';
import { NotImplementedError } from '../packages/core/src/errors';
import { stripComments } from '../packages/core/src/source-mask';
import { parseScriptArgs } from './lib/args';
import { shippedSources } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'not-implemented-copies';
/** Read off core's class, so the code is spelled once — and this rule never names it as its own. */
const CODE = NotImplementedError.code;

/** The one package allowed to spell the code at a construction. */
export const OWNER_PREFIX = 'packages/core/src/';

export interface SourceFile {
  readonly at: string;
  readonly text: string;
}

export interface NotImplementedScan {
  readonly findings: readonly Finding[];
  /** Construction sites inside core — the owner's own, counted so a blind scan cannot read clean. */
  readonly ownerSites: number;
}

/** A literal at a `code:` key or a `code =` member, read off comment-stripped text. */
const LITERAL_AT_KEY = new RegExp(`(?<![.\\w$])code\\s*[:=]\\s*(['"\`])${CODE}\\1`, 'g');

/**
 * The lines a file constructs the code on, read twice. `scanCodeFixSites` — the scanner the
 * manifest and `x errors explain` use — resolves `code: SOME_CONST` to the const's value, but its
 * mask loses its place after a template nested inside another's `${}`, and `admin/src/errors.ts`
 * hid its copy behind one. The literal read over stripped text has no such blind spot. Neither
 * reads a registry's `*_BORROWED_ERROR_CODES` list, which names the code and raises nothing.
 */
function constructionLines(file: SourceFile): readonly number[] {
  const lines = new Set<number>();
  for (const site of scanCodeFixSites(file.text, file.at)) {
    if (site.code === CODE) lines.add(site.line);
  }
  for (const hit of stripComments(file.text).matchAll(LITERAL_AT_KEY)) {
    lines.add(lineOf(file.text, hit.index));
  }
  return [...lines].sort((a, b) => a - b);
}

export function scanNotImplementedCopies(files: readonly SourceFile[]): NotImplementedScan {
  const findings: Finding[] = [];
  let ownerSites = 0;
  for (const file of files) {
    for (const line of constructionLines(file)) {
      if (file.at.startsWith(OWNER_PREFIX)) {
        ownerSites += 1;
        continue;
      }
      findings.push({
        code: 'X_NOT_IMPLEMENTED_COPY',
        cause: `${file.at}:${line} constructs ${CODE} itself, and @ultimat3/core's NotImplementedError is the one constructor of that code`,
        fix: `new NotImplementedError({ cause, fix })   # imported from '@ultimat3/core' and thrown in ${file.at} in place of the local constructor`,
        at: file.at,
      });
    }
  }
  return { findings, ownerSites };
}

/** What the command prints, as a value, so a test reads the `--json` document it publishes. */
export function notImplementedCopiesResult(files: readonly SourceFile[]): ScriptResult {
  const { findings, ownerSites } = scanNotImplementedCopies(files);
  // Core's own constructor is the proof the scanner read anything at all: a scan that found no
  // site anywhere, the owner's included, is a scan that went blind, not a clean tree.
  const blind: readonly Finding[] =
    ownerSites === 0
      ? [
          {
            code: 'X_NOT_IMPLEMENTED_COPY_UNSCANNED',
            cause: `${files.length} files were read and not even ${OWNER_PREFIX}errors.ts's NotImplementedError was found, so a clean answer would mean nothing`,
            fix: 'bun test scripts/not-implemented-copies.test.ts',
          },
        ]
      : [];
  const all = [...blind, ...findings];
  return {
    ok: all.length === 0,
    script: SCRIPT,
    summary:
      all.length === 0
        ? `${files.length} files, ${CODE} constructed only in @ultimat3/core`
        : `${all.length} ${CODE} constructor finding(s) outside @ultimat3/core`,
    findings: all,
    data: { scanned: files.length, ownerSites },
  };
}

export const readSources = shippedSources;

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(notImplementedCopiesResult(await readSources(repoRoot())), args.json);
}
