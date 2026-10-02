// Every point a local write can die at, for a fresh key and for an overwrite, and what a reader
// then sees. The claim is one sentence: NO crash point serves a content type or an etag that does
// not describe the bytes. "Absent", "the previous object, whole" and "these bytes, type unknown"
// are the only three answers a torn write may leave.

import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory API, no recursive remove and no `rename` — `mkdtemp`, `rm` and
// `rename` have no `Bun.*` equivalent, and the fault is injected at the driver's own rename seam.
import { mkdtemp, rename, rm } from 'node:fs/promises';
// why: Bun exposes no `tmpdir()`; `node:os` is the only way to ask the platform where its
// temporary directory is.
import { tmpdir } from 'node:os';
import { DEFAULT_CONTENT_TYPE, etagOf, type StorageDriver } from './driver';
import { localDriver } from './driver-local';
import { commitObject, type WriteSteps } from './driver-local-write';
import { bytesOf, catchError, codeOf, textOf } from './driver-s3-fixture';

const KEY = 'org/o1/doc.bin';
let root = '';
let disk: StorageDriver;

beforeEach(async () => {
  root = await mkdtemp(`${tmpdir()}/ultimate-local-crash-`);
  disk = localDriver({ root, signingSecret: 'test-secret' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const unlink = async (path: string): Promise<void> => {
  await Bun.file(path).delete();
};

/** The process dies INSTEAD of performing step `n` (1-based) of the four the commit makes. */
function dyingAt(n: number): WriteSteps {
  let step = 0;
  const tick = (): void => {
    step += 1;
    if (step === n) throw Object.assign(new Error('power loss'), { code: 'ECRASH' });
  };
  return {
    rename: async (from, to) => {
      tick();
      await rename(from, to);
    },
    unlink: async (path) => {
      tick();
      await unlink(path);
    },
  };
}

/** One write of `text` under `type`, dying at `step`. Step 5 does not exist: it completes. */
const write = (text: string, type: string, step: number): Promise<unknown> =>
  catchError(() =>
    commitObject(
      {
        root,
        key: KEY,
        disk: 'local',
        body: bytesOf(text),
        sidecar: { contentType: type, etag: etagOf(bytesOf(text)) },
      },
      dyingAt(step),
    ),
  );

interface Seen {
  readonly exists: boolean;
  readonly get: string;
  readonly getType: string | undefined;
  readonly getEtagTrue: boolean | undefined;
  readonly statType: string | undefined;
  readonly statEtagTrue: boolean | undefined;
  readonly listType: string | undefined;
  readonly listEtag: string | undefined;
}

/** Everything a reader can ask, with each etag reduced to "does it describe the bytes served". */
async function observe(): Promise<Seen> {
  const read = await disk.get(KEY).catch(() => undefined);
  const stat = await disk.stat(KEY);
  const listed = (await disk.list()).objects.find((object) => object.key === KEY);
  const onDisk = (await Bun.file(`${root}/${KEY}`).exists())
    ? etagOf(new Uint8Array(await Bun.file(`${root}/${KEY}`).arrayBuffer()))
    : undefined;
  return {
    exists: await disk.exists(KEY),
    get: read === undefined ? 'absent' : textOf(read.bytes),
    getType: read?.object.contentType,
    getEtagTrue: read && read.object.etag === etagOf(read.bytes),
    statType: stat?.contentType,
    statEtagTrue: stat && stat.etag === onDisk,
    listType: listed?.contentType,
    listEtag: listed?.etag,
  };
}

const ABSENT: Seen = {
  exists: false,
  get: 'absent',
  getType: undefined,
  getEtagTrue: undefined,
  statType: undefined,
  statEtagTrue: undefined,
  listType: undefined,
  listEtag: undefined,
};
const whole = (text: string, type: string): Seen => ({
  exists: true,
  get: text,
  getType: type,
  getEtagTrue: true,
  statType: type,
  statEtagTrue: true,
  listType: type,
  listEtag: etagOf(bytesOf(text)),
});
/** The bytes are served; nothing claims to know their type, and no etag is asserted for them. */
const untyped = (text: string): Seen => ({
  exists: true,
  get: text,
  getType: DEFAULT_CONTENT_TYPE,
  getEtagTrue: true,
  statType: DEFAULT_CONTENT_TYPE,
  statEtagTrue: true,
  listType: undefined,
  listEtag: '',
});

describe('a write to a FRESH key that dies', () => {
  test.each([1, 2, 3])('at step %d leaves no object at all', async (step) => {
    expect(await write('new-bytes', 'text/new', step)).toBeDefined();
    expect(await observe()).toEqual(ABSENT);
    expect(codeOf(await catchError(() => disk.get(KEY)))).toBe('X_STORAGE_NOT_FOUND');
  });

  test('at step 4 — both files in place, the marker not yet cleared — is the whole object to a read, and untyped to a listing', async () => {
    // Step 4 clears the marker, and a marker that will not clear is not a failed put.
    await write('new-bytes', 'text/new', 4);
    // A listing never reads bytes, so it cannot tell this from the torn state one step earlier.
    expect(await observe()).toEqual({
      ...whole('new-bytes', 'text/new'),
      listType: undefined,
      listEtag: '',
    });
  });

  test.each(['EACCES', 'ENOENT'])(
    'whose marker cannot be cleared (%s) still SUCCEEDED — the object is committed',
    async (errno) => {
      // All three renames landed, so the put happened: reporting X_STORAGE_PUT_FAILED here told the
      // caller to retry a write that is already visible to every reader.
      const outcome = await catchError(() =>
        commitObject(
          {
            root,
            key: KEY,
            disk: 'local',
            body: bytesOf('new-bytes'),
            sidecar: { contentType: 'text/new', etag: etagOf(bytesOf('new-bytes')) },
          },
          {
            rename: (from, to) => rename(from, to),
            unlink: () => Promise.reject(Object.assign(new Error(errno), { code: errno })),
          },
        ),
      );
      expect(outcome).toBeUndefined();
      // Exactly the state a crash at step 4 leaves, which every reader already handles.
      expect(await observe()).toEqual({
        ...whole('new-bytes', 'text/new'),
        listType: undefined,
        listEtag: '',
      });
    },
  );

  test('that completes is the whole object everywhere', async () => {
    expect(await write('new-bytes', 'text/new', 5)).toBeUndefined();
    expect(await observe()).toEqual(whole('new-bytes', 'text/new'));
  });
});

// Different sizes, then the SAME size: a size comparison alone cannot see the second pair.
for (const [before, after] of [
  ['old-bytes-longer', 'new'],
  ['aaaa', 'bbbb'],
] as const) {
  describe(`an OVERWRITE that dies — "${before}" → "${after}"`, () => {
    beforeEach(async () => {
      await disk.put(KEY, bytesOf(before), { contentType: 'text/old' });
    });

    test.each([1, 2])(
      `"${before}" → "${after}" at step %d leaves the previous object, whole`,
      async (step) => {
        expect(await write(after, 'text/new', step)).toBeDefined();
        expect(await observe()).toEqual(whole(before, 'text/old'));
      },
    );

    test(`"${before}" → "${after}" at step 3 — new sidecar, old bytes — serves the old bytes and claims no type`, async () => {
      expect(await write(after, 'text/new', 3)).toBeDefined();
      const seen = await observe();
      expect(seen).toEqual(untyped(before));
      // The two answers a torn pair used to give, spelled out: never the new type, never text/old
      // over an etag that is not the bytes'.
      expect([seen.getType, seen.statType, seen.listType]).not.toContain('text/new');
    });

    test(`"${before}" → "${after}" at step 4 is the new object to a read, and untyped to a listing`, async () => {
      // Step 4 clears the marker, and a marker that will not clear is not a failed put.
      await write(after, 'text/new', 4);
      expect(await observe()).toEqual({
        ...whole(after, 'text/new'),
        listType: undefined,
        listEtag: '',
      });
    });
  });
}

describe('after a torn overwrite', () => {
  test('the next put() after any torn state is a whole object again', async () => {
    await disk.put(KEY, bytesOf('old'), { contentType: 'text/old' });
    await write('torn', 'text/new', 3);
    await disk.put(KEY, bytesOf('healed'), { contentType: 'text/healed' });
    expect(await observe()).toEqual(whole('healed', 'text/healed'));
  });

  test('a copy of a torn object carries the bytes and no borrowed type', async () => {
    await disk.put(KEY, bytesOf('old'), { contentType: 'text/old' });
    await write('new', 'text/new', 3);
    const copied = await disk.copy(KEY, 'org/o1/copy.bin');
    expect(copied.contentType).toBe(DEFAULT_CONTENT_TYPE);
    const read = await disk.get('org/o1/copy.bin');
    expect(textOf(read.bytes)).toBe('old');
    expect(read.object.etag).toBe(etagOf(read.bytes));
    expect(read.object.contentType).toBe(DEFAULT_CONTENT_TYPE);
  });
});
