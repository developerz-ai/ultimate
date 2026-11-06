// Single responsibility: where the local disk keeps an open upload in parts — one directory per
// session under `.meta/.multipart/`, which no key can name (`META_DIR` is reserved) and `list()`
// never yields. A part's bytes land in a staged file renamed into place, so a dropped part is
// absent rather than torn; its etag and size sit beside it.

// why: Bun has no `mkdir`, no `readdir` and no recursive remove; a session is a directory.
import { mkdir, readdir, rename, rm } from 'node:fs/promises';
import type { UploadedPart } from './multipart';
import type { PartStore, StagedSession } from './multipart-staged';
import { META_DIR } from './path';

/** Beside the write staging under `.meta/`, so one reserved segment covers both. */
export const MULTIPART_DIR = `${META_DIR}/.multipart`;

const PART_FILE = /^(\d{1,5})\.part$/;

const isPart = (value: unknown): value is UploadedPart =>
  typeof value === 'object' &&
  value !== null &&
  'partNumber' in value &&
  Number.isSafeInteger(value.partNumber) &&
  'etag' in value &&
  typeof value.etag === 'string' &&
  'size' in value &&
  Number.isSafeInteger(value.size);

const isSession = (value: unknown): value is StagedSession =>
  typeof value === 'object' &&
  value !== null &&
  'key' in value &&
  typeof value.key === 'string' &&
  'contentType' in value &&
  typeof value.contentType === 'string' &&
  'initiated' in value &&
  typeof value.initiated === 'string';

/** A file that is absent or unreadable as JSON is no session: the directory is the disk's own. */
const readJson = async (path: string): Promise<unknown> => {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  return file.json().catch(() => undefined);
};

/** Upload ids are the disk's own UUIDs; anything else never names a directory here. */
const SESSION_ID = /^[A-Za-z0-9-]{1,64}$/;

export function localPartStore(root: string): PartStore {
  const dirOf = (uploadId: string): string | undefined =>
    SESSION_ID.test(uploadId) ? `${root}/${MULTIPART_DIR}/${uploadId}` : undefined;
  const sessionAt = async (uploadId: string): Promise<StagedSession | undefined> => {
    const dir = dirOf(uploadId);
    if (dir === undefined) return undefined;
    const session = await readJson(`${dir}/session.json`);
    return isSession(session) ? session : undefined;
  };

  return {
    async open(uploadId, session): Promise<void> {
      const dir = dirOf(uploadId) ?? '';
      await mkdir(dir, { recursive: true });
      await Bun.write(`${dir}/session.json`, JSON.stringify(session));
    },

    session: sessionAt,

    async writePart(uploadId, part, bytes): Promise<void> {
      const dir = dirOf(uploadId) ?? '';
      const staged = `${dir}/${part.partNumber}.part.tmp`;
      await Bun.write(staged, bytes);
      await Bun.write(`${dir}/${part.partNumber}.json`, JSON.stringify(part));
      await rename(staged, `${dir}/${part.partNumber}.part`);
    },

    async parts(uploadId): Promise<readonly UploadedPart[]> {
      const dir = dirOf(uploadId);
      if (dir === undefined) return [];
      const names = await readdir(dir).catch(() => []);
      const parts: UploadedPart[] = [];
      for (const name of names) {
        const number = PART_FILE.exec(name)?.[1];
        if (number === undefined) continue;
        const part = await readJson(`${dir}/${number}.json`);
        if (isPart(part)) parts.push(part);
      }
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },

    read(uploadId, parts): ReadableStream<Uint8Array> {
      const dir = dirOf(uploadId) ?? '';
      let at = 0;
      let current: ReadableStreamDefaultReader<Uint8Array> | undefined;
      return new ReadableStream<Uint8Array>({
        async pull(controller): Promise<void> {
          for (;;) {
            if (current === undefined) {
              const part = parts[at];
              if (part === undefined) {
                controller.close();
                return;
              }
              at += 1;
              current = Bun.file(`${dir}/${part.partNumber}.part`).stream().getReader();
            }
            const next = await current.read();
            if (!next.done) {
              controller.enqueue(next.value);
              return;
            }
            current = undefined;
          }
        },
        async cancel(reason): Promise<void> {
          await current?.cancel(reason);
        },
      });
    },

    async drop(uploadId): Promise<void> {
      const dir = dirOf(uploadId);
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    },

    async sessions(): Promise<readonly (readonly [string, StagedSession])[]> {
      const ids = await readdir(`${root}/${MULTIPART_DIR}`).catch(() => []);
      const open: (readonly [string, StagedSession])[] = [];
      for (const uploadId of ids) {
        const session = await sessionAt(uploadId);
        if (session !== undefined) open.push([uploadId, session]);
      }
      return open;
    },
  };
}
