#!/usr/bin/env bun
// Enforce, as a build error, that no package above tier 0 writes its own AES call: one function
// seals a value under the app's master key, and it is `seal()` / `open()` in `@ultimat3/core`. A
// second cipher call is a second key source, a second wire format and a second place a purpose is
// not bound — and it is the 214-line column-encryption module one surveyed app wrote by hand.
//
// WHAT IT REPORTS, in shipped package source (tests are fixtures, never reported):
//   - `call`: `subtle.encrypt(` / `subtle.decrypt(`, however `crypto` is reached;
//   - `cipher`: `createCipheriv` / `createDecipheriv` (and their un-`iv` forms) from `node:crypto`;
//   - `algorithm`: a string that IS an AES algorithm name — `'AES-GCM'`, `"aes-256-cbc"`.
// Signing is not sealing: `subtle.sign`, `subtle.verify`, `subtle.digest`, HMAC keys and
// `Bun.CryptoHasher` are never reported. Prose that mentions AES inside a longer string is not an
// algorithm name and is not reported either.
//
// The three files in `SEAL_SEAM` are the rule's own subject and are exempt; a seam file that was
// not scanned makes a clean run prove nothing, and is its own finding.
//
//   bun run seal-calls  ·  bun run scripts/seal-calls.ts [--json]

import { parseScriptArgs } from './lib/args';
import { corpus } from './lib/corpus';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { isTestPath, lineOf } from './lib/source-scan';

const SCRIPT = 'seal-calls';

/** The modules that may call the cipher: the env envelope, the per-value seal, and its key ring. */
export const SEAL_SEAM: readonly string[] = [
  'packages/core/src/secrets.ts',
  'packages/core/src/seal.ts',
  'packages/core/src/seal-keys.ts',
];

export type SealCallKind = 'call' | 'cipher' | 'algorithm';

export interface SealCall {
  readonly file: string;
  readonly line: number;
  readonly kind: SealCallKind;
  /** What was written, so the finding quotes the text the reader will search for. */
  readonly via: string;
}

/** A file as two readings: `masked` blanks strings and comments, `stripped` blanks comments only. */
export interface SealSource {
  readonly path: string;
  readonly masked: string;
  readonly stripped: string;
}

const CALL = /\bsubtle\s*\??\.\s*(encrypt|decrypt)\s*\(/g;
const CIPHER = /\b(createCipheriv|createDecipheriv|createCipher|createDecipher)\b/g;
/** The WHOLE string is the name: a quote, `AES-`, the mode, a quote. Prose never matches. */
const ALGORITHM = /(['"`])(AES-[A-Za-z0-9-]{2,12})\1/gi;

export function sealCalls(file: SealSource): readonly SealCall[] {
  if (SEAL_SEAM.includes(file.path) || isTestPath(file.path)) return [];
  const found: SealCall[] = [];
  const push = (text: string, index: number, kind: SealCallKind, via: string): void => {
    found.push({ file: file.path, line: lineOf(text, index), kind, via });
  };
  // Calls are read in the MASKED text, so a scaffold template that emits one is not a call here.
  for (const call of file.masked.matchAll(CALL)) {
    push(file.masked, call.index, 'call', `subtle.${call[1] ?? ''}(`);
  }
  for (const cipher of file.masked.matchAll(CIPHER)) {
    push(file.masked, cipher.index, 'cipher', cipher[1] ?? '');
  }
  // An algorithm name only exists inside a string, so this one reads the text with strings kept.
  for (const name of file.stripped.matchAll(ALGORITHM)) {
    push(file.stripped, name.index, 'algorithm', name[2] ?? '');
  }
  return found.sort((a, b) => a.line - b.line);
}

export function sealCallFinding(site: SealCall): Finding {
  const what =
    site.kind === 'algorithm'
      ? `names the cipher ${site.via}`
      : `calls ${site.via.replace(/\($/, '')}() itself`;
  return {
    code: 'X_SEAL_CALL_OUTSIDE_CORE',
    at: `${site.file}:${site.line}`,
    cause: `${site.file}:${site.line} ${what}; a value is sealed in one place, seal() / open() in @ultimat3/core, so there is one key source, one wire format and a purpose bound into every value`,
    fix: `edit ${site.file}:${site.line} — call seal(value, { purpose: '<what the value is for>' }) and open(sealed, { purpose }) from '@ultimat3/core' instead; re-read the tree with: bun run seal-calls --json`,
  };
}

export function sealCallResult(files: readonly SealSource[]): ScriptResult {
  const sites = files.flatMap(sealCalls);
  const findings = sites.map(sealCallFinding);
  const scanned = new Set(files.map((file) => file.path));
  const missing = SEAL_SEAM.filter((path) => !scanned.has(path));
  if (missing.length > 0) {
    findings.unshift({
      code: 'X_SEAL_CALL_UNSCANNED',
      at: 'scripts/seal-calls.ts',
      cause: `${missing.join(', ')} was not among the files scanned, so the exemption names nothing and a clean run proves nothing`,
      fix: 'edit SEAL_SEAM in scripts/seal-calls.ts to name the modules that call the cipher, then: bun run seal-calls --json',
    });
  }
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${files.length} files, every cipher call inside ${SEAL_SEAM.length} core modules`
        : `${findings.length} seal call finding(s)`,
    findings,
    data: { files: files.length, sites },
  };
}

/** The rule as a host check: `scripts/verify.ts` runs it on the gate's `boundaries` step. */
export async function sealCallFindings(root: string): Promise<readonly Finding[]> {
  return sealCallResult(await corpus(root, 'shipped')).findings ?? [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(sealCallResult(await corpus(repoRoot(), 'shipped')), args.json);
}
