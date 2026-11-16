// The s3 driver's bounds at construction — its byte ceiling screened, an explicit null refused —
// and a refusal's fix line that never splices a key, a prefix or a bucket into the shell.
// Split from driver-s3.test.ts, which keeps the driver's reads and writes.

import { describe, expect, test } from 'bun:test';
import { s3Driver } from './driver-s3';
import { bytesOf, catchError, codeOf, FakeS3Client } from './driver-s3-fixture';
import type { StorageError } from './errors';

/** The same ceiling on the other driver — `driver-parity.test.ts`'s rule, applied to a refusal. */
describe('the s3 driver byte ceiling is screened at construction', () => {
  test.each([Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5])(
    'refuses maxPutBytes %p, naming it',
    (maxPutBytes) => {
      let rendered = 'no-error-thrown';
      try {
        s3Driver({ bucket: 'b', client: new FakeS3Client(), maxPutBytes });
      } catch (error) {
        rendered = String(error);
      }
      expect(rendered).toContain('X_INVARIANT');
      expect(rendered).toContain('maxPutBytes');
    },
  );

  test('a real ceiling still builds a driver', () => {
    expect(
      typeof s3Driver({ bucket: 'b', client: new FakeS3Client(), maxPutBytes: 1024 }).put,
    ).toBe('function');
  });
});

/**
 * `??` coalesces on `null` as well as `undefined`, so an explicit `null` — what a decoded JSON
 * config carries for a key someone blanked — took the default BEFORE the guard above could refuse
 * it. The mirror of the `NaN` half: one slips past the guard, the other past the default, and both
 * end in a bound nobody chose. `JSON.parse` rather than a literal, because `null` is not in the
 * option's type and this is the caller the bug is about.
 */
describe('an explicitly null s3 bound is refused, never defaulted', () => {
  test('maxPutBytes: null names maxPutBytes', () => {
    const fromJson: number = JSON.parse('null');
    let rendered = 'no-error-thrown';
    try {
      s3Driver({ bucket: 'b', client: new FakeS3Client(), maxPutBytes: fromJson });
    } catch (error) {
      rendered = String(error);
    }
    expect(rendered).toContain('X_INVARIANT');
    expect(rendered).toContain('maxPutBytes');
  });

  test('signedUrl({ expiresInMs: null }) names expiresInMs', async () => {
    const fromJson: number = JSON.parse('null');
    const driver = s3Driver({ bucket: 'b', client: new FakeS3Client() });
    await expect(driver.signedUrl('org/org-1/a.txt', { expiresInMs: fromJson })).rejects.toThrow(
      /expiresInMs/,
    );
  });
});

// `isSafeKey` accepts `$(…)`, a backtick and `;` — they are legal object-key bytes — so the key,
// the prefix and the bucket are screened where they enter the `aws s3api` command a fix: hands
// the reader to paste.
describe('a refusal fix never splices a key, a prefix or a bucket into the shell', () => {
  // The KMS key id is the caller's own `put()` option. It travels as a header now, never inside a
  // command: a refusal about it names it in the cause (rendered) and keeps the fix a placeholder.
  test('a refused KMS key id never reaches the fix', async () => {
    const driver = s3Driver({ bucket: 'b', client: new FakeS3Client() });
    const refused = (await catchError(() =>
      driver.put('org/org-1/a.txt', bytesOf('c'), {
        serverSideEncryption: { algorithm: 'AES256', kmsKeyId: "x' $(touch pwned) '" },
      }),
    )) as StorageError;
    expect(refused).toBeUltimateError('X_INVARIANT');
    expect(refused.fix).not.toContain('$(touch');
  });

  test('a refused delete screens the key', async () => {
    const key = 'org/org-1/$(touch pwned).txt';
    const fake = new FakeS3Client();
    fake.store.set(key, { bytes: bytesOf('c') });
    fake.failDeleteFor = key;
    const driver = s3Driver({ bucket: 'b', client: fake });
    const refused = (await catchError(() => driver.delete(key))) as StorageError;
    expect(codeOf(refused)).toBe('X_STORAGE_DELETE_FAILED');
    expect(refused.fix).not.toContain('$(');
    // Quoted: a bare `<key>` is read by the shell as a redirection from a file named `key`.
    expect(refused.fix).toContain("aws s3api delete-object --bucket b --key '<key>'");
  });

  test('a refused listing screens the prefix', async () => {
    const fake = new FakeS3Client();
    fake.failListWith = Object.assign(new Error('denied'), {
      name: 'S3Error',
      code: 'AccessDenied',
    });
    const driver = s3Driver({ bucket: 'b', client: fake });
    const refused = (await catchError(() => driver.list({ prefix: 'org/`id`;' }))) as StorageError;
    expect(codeOf(refused)).toBe('X_STORAGE_LIST_FAILED');
    expect(refused.fix).not.toContain('`id`');
    expect(refused.fix).toContain("aws s3api list-objects-v2 --bucket b --prefix '<prefix>'");
  });
});
