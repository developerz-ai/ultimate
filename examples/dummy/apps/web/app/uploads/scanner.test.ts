/**
 * unit — Postly's scanner against storage's own `UploadScanner` contract, then its one decision:
 * a small file is judged inline, a large one is HELD by the sandbox until a later ask, then judged.
 */

import { frozenClock } from '@ultimat3/core';
import { EICAR_TEST_STRING, memoryUploadScanner } from '@ultimat3/storage';
import type { ScanInput, UploadScanner } from '@ultimat3/storage/adapter';
import { behavesLike, describe, expect, unitTest } from '@ultimat3/testing';
import { uploadScannerConformance } from '@ultimat3/testing/conformance';
import { memoryScanSandbox, SANDBOX_PENDING, SANDBOX_VERDICT_TTL_MS } from './scan-sandbox';
import { INLINE_SCAN_MAX_BYTES, postlyUploadScanner } from './scanner';

/** One confirm's view of the upload: `revision` names WHICH bytes, as `promoteAttachment` sets it. */
const input = (text: string, size: number): ScanInput => ({
  key: 'org/o/pending/scan/a-f.csv',
  pendingKey: 'org/o/pending/f.csv',
  revision: `rev-${String(Bun.hash(text))}`,
  size,
  contentType: 'text/csv',
  body: new Blob([text]).stream(),
});

/** The vendor's side, counted: every submission the sandbox actually sends. */
const countingEngine = (): UploadScanner & { readonly calls: () => number } => {
  const engine = memoryUploadScanner();
  let calls = 0;
  return {
    name: 'counting',
    scan: (scanned) => {
      calls += 1;
      return engine.scan(scanned);
    },
    calls: () => calls,
  };
};

describe('postlyUploadScanner, small files only', () => {
  behavesLike(uploadScannerConformance, () => postlyUploadScanner());
});

unitTest('declares that it holds, so an outage refuses in every policy', () => {
  expect(postlyUploadScanner().holds).toBe(true);
});

unitTest('a file up to the inline limit is judged in the same ask', async () => {
  const scanner = postlyUploadScanner();
  expect(await scanner.scan(input('id,slug\n', INLINE_SCAN_MAX_BYTES))).toEqual({
    verdict: 'clean',
  });
  expect((await scanner.scan(input(EICAR_TEST_STRING, 68))).verdict).toBe('infected');
});

unitTest('a larger file is held on the first ask and judged on the next, sent once', async () => {
  const engine = countingEngine();
  const scanner = postlyUploadScanner({ sandbox: memoryScanSandbox({ engine }) });
  const big = INLINE_SCAN_MAX_BYTES + 1;

  expect(await scanner.scan(input(EICAR_TEST_STRING, big))).toEqual({
    verdict: 'hold',
    reason: SANDBOX_PENDING,
  });
  expect((await scanner.scan(input(EICAR_TEST_STRING, big))).verdict).toBe('infected');
  // Two checks, one submission: the poll for bytes already judged sends nothing.
  expect(engine.calls()).toBe(1);
});

unitTest('bytes swapped under a held key are a new submission, never the old verdict', async () => {
  const scanner = postlyUploadScanner({ inlineMaxBytes: 0 });

  expect((await scanner.scan(input('id,slug\n', 8))).verdict).toBe('hold');
  // The presigned PUT is still live: the uploader replaces the held file with other bytes.
  expect((await scanner.scan(input(EICAR_TEST_STRING, 68))).verdict).toBe('hold');
  expect((await scanner.scan(input(EICAR_TEST_STRING, 68))).verdict).toBe('infected');
});

unitTest('a verdict expires: past a day the same bytes are held again', async () => {
  const clock = frozenClock('2026-11-10T09:00:00.000Z');
  const scanner = postlyUploadScanner({ inlineMaxBytes: 0, sandbox: memoryScanSandbox({ clock }) });

  await scanner.scan(input('id,slug\n', 8));
  clock.advance(SANDBOX_VERDICT_TTL_MS);
  expect((await scanner.scan(input('id,slug\n', 8))).verdict).toBe('hold');
});

unitTest('a caller that names no revision is still judged by the bytes it sent', async () => {
  const scanner = postlyUploadScanner({ inlineMaxBytes: 0 });
  const unnamed = (text: string): ScanInput => ({ ...input(text, 8), revision: undefined });

  expect((await scanner.scan(unnamed('id,slug\n'))).verdict).toBe('hold');
  expect((await scanner.scan(unnamed(EICAR_TEST_STRING))).verdict).toBe('hold');
  expect((await scanner.scan(unnamed(EICAR_TEST_STRING))).verdict).toBe('infected');
});
