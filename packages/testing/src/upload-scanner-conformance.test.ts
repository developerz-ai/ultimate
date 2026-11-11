// The upload-scanner suite over storage's memory reference, and the proof it can fail: a scanner
// that matches per chunk, one that keeps its last verdict, and one that calls everything infected.

import { describe, expect, test } from 'bun:test';
import { EICAR_TEST_STRING, memoryUploadScanner } from '@ultimat3/storage';
import type { UploadScanner } from '@ultimat3/storage/adapter';
import { behavesLike } from './shared-examples';
import { testName } from './test-types';
import type { UploadScannerLike } from './upload-scanner-conformance';
import {
  UPLOAD_SCANNER_CHECKS,
  UPLOAD_SCANNER_EICAR,
  uploadScannerConformance,
} from './upload-scanner-conformance';

/** Compile-time: storage's port satisfies the structural subject the suite takes. */
const _assignable = (scanner: UploadScanner): UploadScannerLike => scanner;
void _assignable;

describe(testName('unit', 'the memory upload scanner'), () => {
  behavesLike(uploadScannerConformance, memoryUploadScanner);
});

const SIGNATURE = new TextEncoder().encode('EICAR-STANDARD');

/** Looks inside each chunk alone — what a scanner forwarding chunks to a per-buffer API does. */
const perChunk = (): UploadScannerLike => ({
  name: 'per-chunk',
  async scan({ body }) {
    for await (const chunk of body) {
      if (Buffer.from(chunk).includes(SIGNATURE)) return { verdict: 'infected', signature: 'x' };
    }
    return { verdict: 'clean' };
  },
});

/** Remembers the first infected verdict for every later file — a cache keyed on nothing. */
function sticky(): UploadScannerLike {
  const inner = memoryUploadScanner();
  let last: Awaited<ReturnType<UploadScannerLike['scan']>> | undefined;
  return {
    name: 'sticky',
    async scan(input) {
      const verdict = await inner.scan(input);
      if (last?.verdict === 'infected') return last;
      last = verdict;
      return verdict;
    },
  };
}

/**
 * A review queue keyed by `pendingKey` alone: whatever it cleared once it clears again, so the bytes
 * PUT to the same pending key after the approval are attached unscanned.
 */
function keyedByUpload(): UploadScannerLike {
  const inner = memoryUploadScanner();
  const cleared = new Set<string>();
  return {
    name: 'keyed-by-upload',
    async scan(input) {
      if (cleared.has(input.pendingKey)) {
        await input.body.cancel();
        return { verdict: 'clean' };
      }
      const verdict = await inner.scan(input);
      if (verdict.verdict === 'clean') cleared.add(input.pendingKey);
      return verdict;
    },
  };
}

/**
 * CORRECT caching: one verdict per `(pendingKey, revision)`, what a review queue or an async vendor
 * keeps. Distinct bytes are distinct revisions, so it must pass every check — a suite that sends two
 * contents under one revision would fail it for being right.
 */
function pairCached(): UploadScannerLike {
  const inner = memoryUploadScanner();
  const seen = new Map<string, Awaited<ReturnType<UploadScannerLike['scan']>>>();
  return {
    name: 'pair-cached',
    async scan(input) {
      const id = `${input.pendingKey}@${String(input.revision)}`;
      const cached = seen.get(id);
      if (cached !== undefined) {
        await input.body.cancel();
        return cached;
      }
      const verdict = await inner.scan(input);
      seen.set(id, verdict);
      return verdict;
    },
  };
}

const paranoid = (): UploadScannerLike => ({
  name: 'paranoid',
  scan: async () => ({ verdict: 'infected', signature: 'everything' }),
});

const check = (prefix: string) => {
  const found = UPLOAD_SCANNER_CHECKS.find((each) => each.name.startsWith(prefix));
  if (found === undefined) return expect.unreachable(`no upload-scanner check named ${prefix}`);
  return found;
};

describe(testName('unit', 'a scanner that breaks the contract fails conformance'), () => {
  test('the suite and storage agree on the EICAR string', () => {
    expect(UPLOAD_SCANNER_EICAR).toBe(EICAR_TEST_STRING);
  });

  test('a per-chunk matcher fails the chunked check', async () => {
    await check('the EICAR test file is infected').run(perChunk());
    await expect(check('the EICAR test file delivered in').run(perChunk())).rejects.toThrow();
  });

  test('a scanner that keeps its verdict fails the bytes-only check', async () => {
    await expect(check('a verdict is about these bytes only').run(sticky())).rejects.toThrow();
  });

  test('a scanner that keys its decision by the upload alone fails the revision check', async () => {
    const revision = check('a new revision of one upload is judged on its own bytes');
    await expect(revision.run(keyedByUpload())).rejects.toThrow();
    await revision.run(memoryUploadScanner());
  });

  test('a scanner caching by (pendingKey, revision) passes every check: distinct bytes, distinct revisions', async () => {
    const scanner = pairCached();
    for (const each of UPLOAD_SCANNER_CHECKS) await each.run(scanner);
  });

  test('a scanner that calls everything infected fails the clean checks', async () => {
    await expect(check('a plain text file is clean').run(paranoid())).rejects.toThrow();
    await expect(check('an empty file is clean').run(paranoid())).rejects.toThrow();
  });

  test('every check has a name of its own', () => {
    const names = UPLOAD_SCANNER_CHECKS.map((each) => each.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
