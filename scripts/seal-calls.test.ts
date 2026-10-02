// The enforcement half of `scripts/seal-calls.ts`: each shape as a fixture, then the real tree.
// The real-tree test is what makes "no package above tier 0 writes its own AES call" a build error
// on the gate's `unit` step as well as on `boundaries`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { maskLiterals, stripComments } from '../packages/core/src/source-mask';
import { corpus } from './lib/corpus';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';
import type { SealSource } from './seal-calls';
import {
  SEAL_SEAM,
  sealCallFinding,
  sealCallFindings,
  sealCallResult,
  sealCalls,
} from './seal-calls';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AT = 'packages/entity/src/column-crypto.ts';
const file = (source: string, path = AT): SealSource => ({
  path,
  masked: maskLiterals(source),
  stripped: stripComments(source),
});
const kinds = (source: string, path = AT): readonly string[] =>
  sealCalls(file(source, path)).map((site) => `${site.kind}:${site.via}`);

describe('a cipher call outside core', () => {
  test('subtle.encrypt and subtle.decrypt are reported, however crypto is reached', () => {
    expect(kinds('await crypto.subtle.encrypt(params, key, data);')).toEqual([
      'call:subtle.encrypt(',
    ]);
    expect(kinds('const out = await globalThis.crypto.subtle.decrypt(p, k, d);')).toEqual([
      'call:subtle.decrypt(',
    ]);
    expect(kinds('const { subtle } = crypto;\nawait subtle\n  .encrypt(p, k, d);')).toEqual([
      'call:subtle.encrypt(',
    ]);
  });

  test('node:crypto ciphers are reported', () => {
    expect(kinds("import { createCipheriv } from 'node:crypto';")).toEqual([
      'cipher:createCipheriv',
    ]);
    expect(kinds('const d = nodeCrypto.createDecipheriv(alg, key, iv);')).toEqual([
      'cipher:createDecipheriv',
    ]);
  });

  test('a string that IS an AES algorithm name is reported, in any quote and case', () => {
    expect(
      kinds("await crypto.subtle.importKey('raw', k, { name: 'AES-GCM' }, false, u);"),
    ).toEqual(['algorithm:AES-GCM']);
    expect(kinds('const ALG = "aes-256-cbc";')).toEqual(['algorithm:aes-256-cbc']);
  });

  test('the finding names the file, the rewrite and the re-run', () => {
    const [site] = sealCalls(file('\nawait crypto.subtle.encrypt(p, k, d);'));
    const finding = sealCallFinding(site ?? expect.unreachable('no site'));
    expect(finding.code).toBe('X_SEAL_CALL_OUTSIDE_CORE');
    expect(finding.at).toBe(`${AT}:2`);
    expect(finding.cause).toContain('calls subtle.encrypt() itself');
    expect(finding.fix).toContain("seal(value, { purpose: '<what the value is for>' })");
    expect(finding.fix).toContain("from '@ultimat3/core'");
    expect(finding.fix).toContain('bun run seal-calls --json');
  });
});

describe('what is not sealing, and is never reported', () => {
  test('signing, verifying, digesting and HMAC keys', () => {
    expect(kinds("await crypto.subtle.sign('HMAC', key, data);")).toEqual([]);
    expect(kinds("await crypto.subtle.verify('HMAC', key, sig, data);")).toEqual([]);
    expect(kinds("await crypto.subtle.digest('SHA-256', bytes);")).toEqual([]);
    expect(
      kinds("crypto.subtle.importKey('raw', k, { name: 'HMAC', hash: 'SHA-256' }, false, u);"),
    ).toEqual([]);
    expect(kinds("new Bun.CryptoHasher('sha256', secret).update(text).digest('hex');")).toEqual([]);
  });

  test('prose, comments and emitted source', () => {
    expect(kinds("const title = 'sealed with AES-256-GCM under the master key';")).toEqual([]);
    expect(kinds('// crypto.subtle.encrypt( was the old spelling\nconst x = 1;')).toEqual([]);
    expect(kinds('const template = `await crypto.subtle.encrypt(p, k, d);`;')).toEqual([]);
  });

  test('the seam itself, and a test', () => {
    const source = "await crypto.subtle.encrypt({ name: 'AES-GCM' }, key, data);";
    for (const path of SEAL_SEAM) expect(kinds(source, path)).toEqual([]);
    expect(kinds(source, 'packages/entity/src/sealed.test.ts')).toEqual([]);
    expect(kinds(source, 'packages/core/src/other.ts')).toHaveLength(2);
  });
});

describe('the result', () => {
  test('a seam file that was not scanned is its own finding', () => {
    const result = sealCallResult([file('export const a = 1;')]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual(['X_SEAL_CALL_UNSCANNED']);
    expect(result.findings?.[0]?.cause).toContain('packages/core/src/seal.ts');
  });

  test('the real tree: every cipher call is inside the seam, and the seam really calls it', async () => {
    const files = await corpus(repoRoot(), 'shipped');
    const result = sealCallResult(files);
    expect(result.findings).toEqual([]);
    // The same answer through the host check `scripts/verify.ts` puts on the `boundaries` step.
    expect(await sealCallFindings(repoRoot())).toEqual([]);
    // The exemption is not vacuous: unexempted, the seam's own files are what the rule finds.
    const seam = files.filter((entry) => SEAL_SEAM.includes(entry.path));
    const unexempt = seam.flatMap((entry) => sealCalls({ ...file(entry.source), path: AT }));
    expect(unexempt.some((site) => site.via === 'subtle.encrypt(')).toBe(true);
    expect(unexempt.some((site) => site.via === 'subtle.decrypt(')).toBe(true);
  });
});
