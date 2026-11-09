// The fake provider's copy answers, split from `driver-s3-fixture.ts` to keep that file one size:
// CopyObject (directive COPY — the source's headers travel), UploadPartCopy over a source range,
// and the signed HEAD a multipart copy reads the source's headers with. S3's own shapes and codes.

/** One stored object as the fake holds it — `FakeObject`, restated structurally to avoid a cycle. */
export interface CopySource {
  bytes: Uint8Array;
  type?: string | undefined;
  etag?: string | undefined;
  lastModified?: string | Date | undefined;
}

/** What the copy answers read and write on the fake. */
export interface CopyStore {
  readonly store: Map<string, CopySource>;
  readonly headersOf: Map<string, Readonly<Record<string, string>>>;
  readonly etagOf: (entry: CopySource) => string;
}

export const xmlError = (code: string, message: string, status: number): Response =>
  new Response(
    `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`,
    { status, headers: { 'content-type': 'application/xml' } },
  );

/** The source a copy names, or S3's refusal: absent is 404, another revision 412. */
function sourceOf(
  fake: CopyStore,
  headers: Readonly<Record<string, string>>,
  ifMatch: string | undefined,
): { readonly from: string; readonly entry: CopySource } | Response {
  const named = headers['x-amz-copy-source'] ?? '';
  const from = decodeURIComponent(named).split('/').slice(2).join('/');
  const entry = fake.store.get(from);
  if (entry === undefined) return xmlError('NoSuchKey', 'The specified key does not exist.', 404);
  if (ifMatch !== undefined && fake.etagOf(entry) !== ifMatch) {
    return xmlError('PreconditionFailed', 'At least one precondition failed', 412);
  }
  return { from, entry };
}

/** CopyObject: bytes, type AND the recorded headers, because S3's default directive is COPY. */
export function copyObjectAnswer(
  fake: CopyStore,
  key: string,
  headers: Readonly<Record<string, string>>,
): Response {
  const found = sourceOf(fake, headers, headers['x-amz-copy-source-if-match']);
  if (found instanceof Response) return found;
  fake.store.set(key, { ...found.entry, bytes: found.entry.bytes.slice() });
  const recorded = fake.headersOf.get(found.from);
  if (recorded === undefined) fake.headersOf.delete(key);
  else fake.headersOf.set(key, recorded);
  return new Response('<CopyObjectResult></CopyObjectResult>');
}

/** UploadPartCopy: the window `x-amz-copy-source-range` names, or S3's refusal. */
export function partCopyBytes(
  fake: CopyStore,
  headers: Readonly<Record<string, string>>,
): Uint8Array | Response {
  const found = sourceOf(fake, headers, headers['x-amz-copy-source-if-match']);
  if (found instanceof Response) return found;
  const [, first = '0', last = '0'] =
    /^bytes=(\d+)-(\d+)$/.exec(headers['x-amz-copy-source-range'] ?? '') ?? [];
  return found.entry.bytes.slice(Number(first), Number(last) + 1);
}

/** A signed HEAD: the headers a PUT recorded, the type, the size and the etag. */
export function headAnswer(
  fake: CopyStore,
  key: string,
  headers: Readonly<Record<string, string>>,
): Response {
  const entry = fake.store.get(key);
  if (entry === undefined) return new Response(null, { status: 404 });
  const etag = fake.etagOf(entry);
  const ifMatch = headers['if-match'];
  if (ifMatch !== undefined && ifMatch !== etag) return new Response(null, { status: 412 });
  const recorded = Object.entries(fake.headersOf.get(key) ?? {}).filter(
    ([name]) => name.startsWith('x-amz-meta-') || name === 'cache-control',
  );
  return new Response(null, {
    status: 200,
    headers: {
      ...Object.fromEntries(recorded),
      'content-type': entry.type ?? 'application/octet-stream',
      'content-length': String(entry.bytes.byteLength),
      etag,
    },
  });
}
