// The enforcement half of `scripts/keyed-hasher.ts`: each shape as a fixture, then the real tree.
// The real-tree test is what makes "every HMAC goes through `hmac()`" a build error on the gate's
// `unit` step as well as on `boundaries`.

import { describe, expect, setDefaultTimeout, test } from 'bun:test';
import { collectGuardedFiles } from './async-context-guard';
import {
  HMAC_SEAM,
  KEYED_HASHER_EXEMPT,
  keyedHasherFinding,
  keyedHasherFindings,
  keyedHasherResult,
  keyedHashers,
} from './keyed-hasher';
import { REPO_SCAN_TIMEOUT_MS, repoRoot } from './lib/run';

setDefaultTimeout(REPO_SCAN_TIMEOUT_MS);

const AT = 'packages/auth/src/signing.ts';
const calls = (source: string, path = AT): readonly string[] =>
  keyedHashers(path, source).map((site) => site.call);

describe('a keyed hasher outside the helper', () => {
  test('two arguments is a keyed hasher, however it is reached and laid out', () => {
    expect(calls("new Bun.CryptoHasher('sha256', secret).update(body).digest('hex');")).toEqual([
      "CryptoHasher('sha256', secret)",
    ]);
    expect(calls("const { CryptoHasher } = Bun;\nnew CryptoHasher('sha1', key);")).toEqual([
      "CryptoHasher('sha1', key)",
    ]);
    expect(calls("new Bun.CryptoHasher(\n  'sha256',\n  pick(a, b),\n).update(x);")).toEqual([
      "CryptoHasher( 'sha256', pick(a, b), )",
    ]);
  });

  test('its line is the line the constructor is on', () => {
    const sites = keyedHashers(AT, "const a = 1;\n\nconst h = new Bun.CryptoHasher('sha256', k);");
    expect(sites.map((site) => site.line)).toEqual([3]);
  });

  test('the finding names the file, the helper and a command to re-read', () => {
    const site = keyedHashers(AT, "new Bun.CryptoHasher('sha256', k);")[0];
    const finding = keyedHasherFinding(site ?? expect.unreachable('no site was reported'));
    expect(finding.code).toBe('X_KEYED_HASHER');
    expect(finding.at).toBe(`${AT}:1`);
    expect(finding.fix).toContain(`at ${AT}:1`);
    expect(finding.fix).toContain("import { hmac } from '@ultimat3/core'");
    expect(finding.fix).toContain('bun run keyed-hasher --json');
  });
});

describe('what it leaves alone', () => {
  test('an unkeyed hasher, a comma inside the one argument, a string, a comment', () => {
    expect(calls("new Bun.CryptoHasher('sha256').update(body).digest('hex');")).toEqual([]);
    expect(calls('new Bun.CryptoHasher(pick(a, b));')).toEqual([]);
    expect(calls('const doc = "new Bun.CryptoHasher(\'sha256\', key)";')).toEqual([]);
    expect(calls("// new Bun.CryptoHasher('sha256', key) was the old spelling\n")).toEqual([]);
    // Emitted source: the call is the template's TEXT, built from parts so `${…}` stays literal.
    expect(calls(["const t = `new Bun.CryptoHasher('sha256', $", '{k})`;'].join(''))).toEqual([]);
  });

  test('the seam and the exempt bug pin, and nothing else', () => {
    const keyed = "new Bun.CryptoHasher('sha256', key);";
    const files = [
      { path: HMAC_SEAM, source: keyed },
      ...Object.keys(KEYED_HASHER_EXEMPT).map((path) => ({ path, source: keyed })),
    ];
    expect(keyedHasherResult(files).findings).toEqual([]);
    const other = keyedHasherResult([
      ...files,
      { path: 'packages/core/src/x.test.ts', source: keyed },
    ]);
    expect(other.findings?.map((finding) => finding.code)).toEqual(['X_KEYED_HASHER']);
  });
});

describe('the exemption', () => {
  test('a row whose file was not scanned is its own finding', () => {
    const result = keyedHasherResult([{ path: AT, source: 'export const a = 1;' }]);
    expect(result.ok).toBe(false);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_KEYED_HASHER_EXEMPT_STALE',
    ]);
    expect(result.findings?.[0]?.cause).toContain('was not among the files scanned');
  });

  test('a row whose file holds no keyed hasher excuses nothing, and says so', () => {
    const files = Object.keys(KEYED_HASHER_EXEMPT).map((path) => ({
      path,
      source: 'const a = 1;',
    }));
    const result = keyedHasherResult(files);
    expect(result.findings?.map((finding) => finding.code)).toEqual([
      'X_KEYED_HASHER_EXEMPT_STALE',
    ]);
    expect(result.findings?.[0]?.cause).toContain('holds no keyed Bun.CryptoHasher');
  });
});

describe('the real tree', () => {
  test('every HMAC goes through hmac(), and the bug pin really holds a raw keyed hasher', async () => {
    const files = await collectGuardedFiles(repoRoot());
    expect(keyedHasherResult(files).findings).toEqual([]);
    // The same answer through the host check `scripts/verify.ts` puts on the `boundaries` step.
    expect(await keyedHasherFindings(repoRoot())).toEqual([]);
    // The tree is the tree: the helper and the nine sites it replaced were all read.
    const paths = new Set(files.map((file) => file.path));
    expect(paths.has(HMAC_SEAM)).toBe(true);
    expect(paths.has('packages/http/src/webhook-hmac.ts')).toBe(true);
    expect(paths.has('examples/dummy/apps/web/app/webhooks/jobs.job.test.ts')).toBe(true);
  });
});
