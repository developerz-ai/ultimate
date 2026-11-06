// Single responsibility: the S3 multipart calls (create, part, complete, abort, list parts, list uploads) over the disk's signed requests. Each answers
// what its caller goes on with, or hands the provider's refusal to the disk's coded `refused`. The
// order they run in, and what a failure aborts, is the caller's.

import { escapeHtml } from '@ultimat3/core';
import { type S3Refusal, type S3WireOptions, sendSigned, xmlField } from './driver-s3-signed';
import type { MultipartSession, UploadedPart } from './multipart';

export interface S3UploadTarget {
  readonly wire: S3WireOptions;
  readonly key: string;
  /** The disk's coded write refusal. A refusal is never thrown bare. */
  readonly refused: (refusal: S3Refusal) => never;
}

const unreadable = (what: string): S3Refusal => ({
  name: 'S3Error',
  code: 'UnreadableAnswer',
  message: `the provider's answer to ${what} carried nothing to go on`,
  statusCode: 200,
});

/** Every `<name>…</name>` block of an S3 listing, in order; the shapes read here are flat. */
export const xmlBlocks = (xml: string, name: string): readonly string[] =>
  [...xml.matchAll(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'g'))].map(
    (match) => match[1] ?? '',
  );

/** XML's entities: S3 writes an etag as `&quot;…&quot;` and a key's `&` as `&amp;`. */
export const xmlText = (text: string): string =>
  text
    // A numeric reference too: a gateway writes the etag's quotes as `&#34;`, S3 as `&quot;`.
    .replace(/&#(x[0-9a-f]{1,6}|[0-9]{1,7});/gi, (_, code: string) =>
      String.fromCodePoint(
        Math.min(Number(code[0] === 'x' || code[0] === 'X' ? `0${code}` : code), 0x10ffff),
      ),
    )
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&');

// Core's table: `&#39;`/`&quot;` are numeric/XML references too, so its output is valid XML text.
const completeXml = (parts: readonly { partNumber: number; etag: string }[]): Uint8Array =>
  new TextEncoder().encode(
    `<CompleteMultipartUpload>${parts
      .map(
        ({ partNumber, etag }) =>
          `<Part><PartNumber>${partNumber}</PartNumber><ETag>${escapeHtml(etag)}</ETag></Part>`,
      )
      .join('')}</CompleteMultipartUpload>`,
  );

/** CreateMultipartUpload. The object's own headers travel here: a part has none. */
export async function createS3Upload(
  { wire, key, refused }: S3UploadTarget,
  headers: Readonly<Record<string, string>>,
): Promise<string> {
  const result = await sendSigned(wire, { method: 'POST', key, headers, query: { uploads: '' } });
  if (!result.ok) return refused(result.refusal);
  const id = xmlField(await result.response.text(), 'UploadId');
  return id === undefined ? refused(unreadable('CreateMultipartUpload')) : id;
}

/** UploadPart, answering the etag the Complete must name. */
export async function uploadS3Part(
  { wire, key, refused }: S3UploadTarget,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
): Promise<string> {
  const result = await sendSigned(wire, {
    method: 'PUT',
    key,
    query: { partNumber: String(partNumber), uploadId },
    body,
  });
  if (!result.ok) return refused(result.refusal);
  await result.response.body?.cancel().catch(() => undefined);
  const etag = result.response.headers.get('etag');
  return etag === null ? refused(unreadable('UploadPart')) : etag;
}

/** CompleteMultipartUpload, `parts` ascending. The object exists only once this returns. */
export async function completeS3Upload(
  { wire, key, refused }: S3UploadTarget,
  uploadId: string,
  parts: readonly { readonly partNumber: number; readonly etag: string }[],
): Promise<void> {
  const result = await sendSigned(wire, {
    method: 'POST',
    key,
    query: { uploadId },
    body: completeXml(parts),
  });
  if (!result.ok) return refused(result.refusal);
  // S3 answers a failed Complete with 200 and an `<Error>` body, once it has started working.
  const answer = await result.response.text();
  if (answer.includes('<Error>')) {
    refused({
      name: 'S3Error',
      code: xmlField(answer, 'Code') ?? 'CompleteFailed',
      message: xmlField(answer, 'Message') ?? 'the provider refused the Complete',
      statusCode: 200,
    });
  }
}

/** AbortMultipartUpload. `undefined` on success; the refusal otherwise, for the caller to weigh. */
export async function abortS3Upload(
  { wire, key }: S3UploadTarget,
  uploadId: string,
): Promise<S3Refusal | undefined> {
  const result = await sendSigned(wire, { method: 'DELETE', key, query: { uploadId } });
  return result.ok ? undefined : result.refusal;
}

/** ListParts, every page: what landed, which is the resume and the Complete's etags. */
export async function listS3Parts(
  { wire, key, refused }: S3UploadTarget,
  uploadId: string,
): Promise<readonly UploadedPart[]> {
  const parts: UploadedPart[] = [];
  let marker: string | undefined;
  for (;;) {
    const query = { uploadId, ...(marker === undefined ? {} : { 'part-number-marker': marker }) };
    const result = await sendSigned(wire, { method: 'GET', key, query });
    if (!result.ok) return refused(result.refusal);
    const answer = await result.response.text();
    for (const block of xmlBlocks(answer, 'Part')) {
      const partNumber = Number(xmlField(block, 'PartNumber'));
      const size = Number(xmlField(block, 'Size'));
      const etag = xmlText(xmlField(block, 'ETag') ?? '');
      if (Number.isSafeInteger(partNumber) && Number.isSafeInteger(size) && etag !== '') {
        parts.push({ partNumber, etag, size });
      }
    }
    marker = xmlField(answer, 'NextPartNumberMarker');
    if (xmlField(answer, 'IsTruncated') !== 'true' || marker === undefined) break;
  }
  return parts.sort((a, b) => a.partNumber - b.partNumber);
}

/** ListMultipartUploads under a prefix, every page: the sessions nobody completed or aborted. */
export async function listS3Uploads(
  { wire, refused }: Omit<S3UploadTarget, 'key'>,
  prefix: string | undefined,
): Promise<readonly MultipartSession[]> {
  const sessions: MultipartSession[] = [];
  let markers: Readonly<Record<string, string>> = {};
  for (;;) {
    const query = { uploads: '', ...(prefix === undefined ? {} : { prefix }), ...markers };
    const result = await sendSigned(wire, { method: 'GET', key: '', query });
    if (!result.ok) return refused(result.refusal);
    const answer = await result.response.text();
    for (const block of xmlBlocks(answer, 'Upload')) {
      const key = xmlText(xmlField(block, 'Key') ?? '');
      const uploadId = xmlText(xmlField(block, 'UploadId') ?? '');
      const initiated = new Date(xmlField(block, 'Initiated') ?? '');
      if (key === '' || uploadId === '') continue;
      sessions.push({
        key,
        uploadId,
        ...(Number.isNaN(initiated.getTime()) ? {} : { initiated }),
      });
    }
    const nextKey = xmlField(answer, 'NextKeyMarker');
    const nextId = xmlField(answer, 'NextUploadIdMarker');
    if (xmlField(answer, 'IsTruncated') !== 'true' || nextKey === undefined) break;
    markers = {
      'key-marker': xmlText(nextKey),
      ...(nextId === undefined ? {} : { 'upload-id-marker': xmlText(nextId) }),
    };
  }
  return sessions;
}
