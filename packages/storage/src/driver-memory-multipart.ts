// Single responsibility: where the memory disk keeps an open upload in parts — a `Map` beside its
// objects, holding copies, so a test's disk answers the local disk's multipart contract with
// nothing on a filesystem.

import type { UploadedPart } from './multipart';
import type { PartStore, StagedSession } from './multipart-staged';

interface Held {
  readonly session: StagedSession;
  readonly parts: Map<number, { readonly part: UploadedPart; readonly bytes: Uint8Array }>;
}

export function memoryPartStore(): PartStore {
  const held = new Map<string, Held>();
  return {
    async open(uploadId, session): Promise<void> {
      held.set(uploadId, { session, parts: new Map() });
    },
    async session(uploadId): Promise<StagedSession | undefined> {
      return held.get(uploadId)?.session;
    },
    async writePart(uploadId, part, bytes): Promise<void> {
      held.get(uploadId)?.parts.set(part.partNumber, { part, bytes: bytes.slice() });
    },
    async parts(uploadId): Promise<readonly UploadedPart[]> {
      const parts = [...(held.get(uploadId)?.parts.values() ?? [])].map(({ part }) => part);
      return parts.sort((a, b) => a.partNumber - b.partNumber);
    },
    read(uploadId, parts): ReadableStream<Uint8Array> {
      const stored = held.get(uploadId)?.parts;
      const chunks = parts.map(({ partNumber }) => stored?.get(partNumber)?.bytes.slice());
      return new Blob(chunks.filter((chunk) => chunk !== undefined)).stream();
    },
    async drop(uploadId): Promise<void> {
      held.delete(uploadId);
    },
    async sessions(): Promise<readonly (readonly [string, StagedSession])[]> {
      return [...held].map(([uploadId, { session }]) => [uploadId, session] as const);
    },
  };
}
