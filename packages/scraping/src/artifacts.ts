// Run artifacts: the page HTML, the screenshot, the downloaded file. A scrape that failed and
// kept nothing is a scrape somebody has to reproduce by hand, and the page it failed on no longer
// exists by the time they look.
//
// Written through `@ultimat3/storage`'s driver, so the same call lands on a local disk in
// development and on S3 in production, and this package owns no upload path of its own.

import type { StorageDriver } from '@ultimat3/storage';

export interface ArtifactRef {
  readonly key: string;
  readonly bytes: number;
  readonly contentType: string;
}

export interface ArtifactWriter {
  /** Bytes under this run's own prefix. Answers the key, which is what a report links to. */
  save(name: string, body: Uint8Array | string, contentType?: string): Promise<ArtifactRef>;
  /** Everything written by this run, in order. Bounded by how many the body asked for. */
  readonly saved: readonly ArtifactRef[];
}

export interface ArtifactWriterInit {
  readonly storage: StorageDriver | undefined;
  readonly scrape: string;
  readonly runId: string;
  /** Optional prefix, so an app can keep scrape artifacts out of its user-upload namespace. */
  readonly prefix?: string | undefined;
}

export const DEFAULT_ARTIFACT_PREFIX = 'scrape';

export const DEFAULT_CONTENT_TYPE = 'application/octet-stream';

/**
 * A `Map`, not an object literal — the same choice `failures.ts` makes, for the same reason. The
 * extension comes off a caller-supplied filename, and on a download that filename came off the
 * site's own `Content-Disposition`: indexing a plain object with it answered a FUNCTION for
 * `report.constructor` and an object for `report.__proto__`, where the type says `string`, and
 * that non-string went on to be `ref.contentType` and an S3 header.
 */
const CONTENT_TYPES: ReadonlyMap<string, string> = new Map([
  ['html', 'text/html; charset=utf-8'],
  ['png', 'image/png'],
  ['pdf', 'application/pdf'],
  ['json', 'application/json'],
  ['csv', 'text/csv'],
  ['txt', 'text/plain; charset=utf-8'],
]);

export const contentTypeFor = (name: string): string =>
  CONTENT_TYPES.get(name.split('.').pop()?.toLowerCase() ?? '') ?? DEFAULT_CONTENT_TYPE;

/**
 * A writer with no storage driver is a NO-OP that still answers a key — never a throw. An app
 * that has not configured storage should still be able to run a scrape; losing the artifact is a
 * cost, and refusing the run over it is a bigger one.
 */
export function createArtifactWriter(init: ArtifactWriterInit): ArtifactWriter {
  const saved: ArtifactRef[] = [];
  const prefix = `${init.prefix ?? DEFAULT_ARTIFACT_PREFIX}/${init.scrape}/${init.runId}`;
  return {
    saved,
    async save(name, body, contentType): Promise<ArtifactRef> {
      const bytes = typeof body === 'string' ? new TextEncoder().encode(body) : body;
      const ref: ArtifactRef = {
        key: `${prefix}/${name}`,
        bytes: bytes.byteLength,
        contentType: contentType ?? contentTypeFor(name),
      };
      if (init.storage !== undefined) {
        await init.storage.put(ref.key, bytes, { contentType: ref.contentType });
      }
      saved.push(ref);
      return ref;
    },
  };
}
