// Single responsibility: per-object server-side encryption on the s3 disk — `serverSideEncryption`
// as the `x-amz-server-side-encryption*` headers of the signed PUT, screened before a byte moves.
// `Bun.S3Client` has no field for it, so an SSE put always rides the signed wire.

import { assert, describeValue } from '@ultimat3/core';
import { HEADER_VALUE, type PutOptions } from './driver';

const ALGORITHMS: readonly string[] = ['AES256', 'aws:kms'];

/**
 * The headers `serverSideEncryption` becomes; none without it. What the provider would answer with
 * a 400 — an algorithm it does not know, a key id beside `AES256`, a key id that cannot travel as a
 * header — is refused here instead, so a refused write is never mistaken for a lost one.
 */
export function sseHeaders(options: PutOptions): Record<string, string> {
  const sse = options.serverSideEncryption;
  if (sse === undefined) return {};
  const algorithm: unknown = sse.algorithm;
  assert(
    typeof algorithm === 'string' && ALGORITHMS.includes(algorithm),
    `put() on the s3 disk was given a serverSideEncryption algorithm the provider does not take (${describeValue(algorithm)})`,
    "put(key, body, { serverSideEncryption: { algorithm: 'AES256' } }) — or algorithm: 'aws:kms'",
  );
  const keyId: unknown = sse.kmsKeyId;
  if (keyId === undefined) return { 'x-amz-server-side-encryption': algorithm };
  assert(
    algorithm === 'aws:kms',
    'put() on the s3 disk was given serverSideEncryption.kmsKeyId with AES256, which takes no key',
    "put(key, body, { serverSideEncryption: { algorithm: 'aws:kms', kmsKeyId } }) — or drop kmsKeyId for AES256",
  );
  assert(
    typeof keyId === 'string' && keyId !== '' && HEADER_VALUE.test(keyId),
    `put() on the s3 disk was given a serverSideEncryption.kmsKeyId that cannot travel as a header (${describeValue(keyId)})`,
    "put(key, body, { serverSideEncryption: { algorithm: 'aws:kms', kmsKeyId: 'arn:aws:kms:<region>:<account>:key/<id>' } }) — or omit kmsKeyId for the bucket's default key",
  );
  return {
    'x-amz-server-side-encryption': algorithm,
    'x-amz-server-side-encryption-aws-kms-key-id': keyId,
  };
}
