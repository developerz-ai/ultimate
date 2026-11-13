#!/usr/bin/env bun
// Enforce, as a build error, that every HMAC in this repository is taken through `hmac()` in
// `packages/core/src/hmac.ts`: a keyed `new Bun.CryptoHasher(alg, key)` — two arguments or more —
// is refused everywhere else, tests and both tracked apps included.
//
// WHY A RULE AND NOT A HABIT. Bun 1.4.4: after a WebCrypto EC import fails anywhere in the process
// (one bad JWKS or VAPID key), the NEXT keyed `Bun.CryptoHasher` throws that stale OpenSSL error
// once. Nine shipped sites — a webhook signature, a cursor, an OAuth cookie, a TOTP code, a keyed
// fingerprint — each threw for one request after the bad key, and `jobs`' webhook suite failed
// only when `pwa`'s VAPID suite ran first in the same process. One helper is one place to route
// around it, and this guard is what keeps a tenth site from being written the old way.
//
// WHAT IT READS: `CryptoHasher(` in code (strings and comments masked, so a fixture string and a
// scaffold template are not calls), its arguments split on top-level commas. An UNKEYED hasher
// (`new Bun.CryptoHasher('sha256')`) is plain hashing, unaffected, and never reported.
// WHAT IT CANNOT SEE, honestly: the constructor stored in a variable and `new`ed off that
// (`const H = Bun.CryptoHasher; new H(alg, key)`), and any runtime resolution. A floor.
//
// `KEYED_HASHER_EXEMPT` is the Bun-bug pin, which must reach for the raw hasher to prove the bug
// still exists; a row whose file was not scanned, or holds no keyed hasher, is its own finding.
//
//   bun run keyed-hasher  ·  bun run scripts/keyed-hasher.ts [--json]

import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import { collectGuardedFiles } from './async-context-guard';
import type { SourceFile } from './boundaries';
import { parseScriptArgs } from './lib/args';
import { balancedClose, topLevelArguments } from './lib/balanced-paren';
import type { Finding, ScriptResult } from './lib/log';
import { report } from './lib/log';
import { repoRoot } from './lib/run';
import { lineOf } from './lib/source-scan';

const SCRIPT = 'keyed-hasher';

/** The one keyed hash. It is built on `node:crypto` and names no `CryptoHasher` at all. */
export const HMAC_SEAM = 'packages/core/src/hmac.ts';

/** Files that must hold a raw keyed hasher, each with the reason. Never a convenience row. */
export const KEYED_HASHER_EXEMPT = Object.freeze<Record<string, string>>({
  'packages/core/src/hmac.test.ts':
    'the Bun 1.4.4 bug pin: asserts the raw keyed hasher still throws after a failed EC import',
});

export interface KeyedHasherSite {
  readonly file: string;
  readonly line: number;
  /** The call as written, comments removed, for the finding to quote back. */
  readonly call: string;
}

const CONSTRUCTOR = /\bCryptoHasher\s*\(/g;

/**
 * Every keyed construction in one file. `stripped` keeps strings so arguments split correctly. A
 * file that never spells `CryptoHasher` holds none and is not masked at all — 75 of ~10,000 do, and
 * masking the rest twice was 4.9 s of the `boundaries` step (measured 2026-11-13). A corpus file
 * hands its own masks in, so the one it already computed is never computed again.
 */
export function keyedHashers(
  path: string,
  source: string,
  masks: Pick<SourceFile, 'masked' | 'stripped'> = {},
): readonly KeyedHasherSite[] {
  if (!source.includes('CryptoHasher')) return [];
  const masked = masks.masked ?? maskLiterals(source);
  const stripped = masks.stripped ?? stripComments(source);
  const sites: KeyedHasherSite[] = [];
  for (const found of masked.matchAll(CONSTRUCTOR)) {
    const open = found.index + found[0].length - 1;
    const close = balancedClose(stripped, open);
    // Unterminated is reported: an argument list this scan cannot read is not proven unkeyed.
    const inner = close < 0 ? stripped.slice(open + 1) : stripped.slice(open + 1, close);
    const args = topLevelArguments(inner).filter((arg) => arg !== '');
    if (close >= 0 && args.length < 2) continue;
    const call = stripped.slice(found.index, close < 0 ? open + 1 : close + 1).replace(/\s+/g, ' ');
    sites.push({ file: path, line: lineOf(masked, found.index), call });
  }
  return sites;
}

export function keyedHasherFinding(site: KeyedHasherSite): Finding {
  return {
    code: 'X_KEYED_HASHER',
    at: `${site.file}:${site.line}`,
    cause: `${site.file}:${site.line} takes an HMAC with ${site.call}; under Bun 1.4.4 a keyed Bun.CryptoHasher throws a stale OpenSSL error once after any failed WebCrypto EC import in the process, and ${HMAC_SEAM} is the one keyed hash that routes around it`,
    fix: `import { hmac } from '@ultimat3/core' — then at ${site.file}:${site.line} write hmac('sha256', key, data, 'hex') (no encoding for bytes; a list of parts for several update() calls); re-read the tree with: bun run keyed-hasher --json`,
  };
}

export function keyedHasherResult(files: readonly SourceFile[]): ScriptResult {
  const findings: Finding[] = [];
  const exemptHits = new Map<string, number>();
  let sites = 0;
  for (const file of files) {
    if (file.path === HMAC_SEAM) continue;
    const found = keyedHashers(file.path, file.source, file);
    if (Object.hasOwn(KEYED_HASHER_EXEMPT, file.path)) {
      exemptHits.set(file.path, found.length);
      continue;
    }
    sites += found.length;
    findings.push(...found.map(keyedHasherFinding));
  }
  for (const path of Object.keys(KEYED_HASHER_EXEMPT)) {
    const hits = exemptHits.get(path);
    if (hits !== undefined && hits > 0) continue;
    findings.unshift({
      code: 'X_KEYED_HASHER_EXEMPT_STALE',
      at: 'scripts/keyed-hasher.ts',
      cause:
        hits === undefined
          ? `${path} was not among the files scanned, so its exemption names nothing and a clean run proves nothing`
          : `${path} is exempt and holds no keyed Bun.CryptoHasher, so the exemption excuses nothing — the Bun bug pin was deleted or rewritten`,
      fix: `export const KEYED_HASHER_EXEMPT = Object.freeze<Record<string, string>>({ /* without the '${path}' row, or with it renamed */ }); — in scripts/keyed-hasher.ts, then: bun run keyed-hasher --json`,
    });
  }
  return {
    ok: findings.length === 0,
    script: SCRIPT,
    summary:
      findings.length === 0
        ? `${files.length} files, every HMAC through ${HMAC_SEAM}`
        : `${findings.length} keyed hasher finding(s)`,
    findings,
    data: { files: files.length, sites },
  };
}

/** The rule as a host check: `scripts/verify.ts` runs it on the gate's `boundaries` step. */
export async function keyedHasherFindings(root: string): Promise<readonly Finding[]> {
  return keyedHasherResult(await collectGuardedFiles(root)).findings ?? [];
}

if (import.meta.main) {
  const args = parseScriptArgs(Bun.argv.slice(2));
  report(keyedHasherResult(await collectGuardedFiles(repoRoot())), args.json);
}
