// A second boot over a POPULATED disk the app declared: the object written before it is still read,
// and a signed URL minted before it still resolves. The 31.0 re-declaration replaced the app's
// registry with the boot's one-disk default — every stored object 404'd and every signed URL named
// a disk that no longer existed. Real files on a real root, through `startStorage` itself.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove; the populated root is a throwaway.
import { mkdtempSync, rmSync } from 'node:fs';
// why: Bun exposes no tmpdir(); the throwaway root lives in the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import {
  defineStorage,
  disk,
  localDriver,
  readSignedObject,
  resetStorage,
} from '@ultimat3/storage';
import type { DevServices } from './runtime-bindings';
import { startStorage } from './runtime-storage-boot';

const DEV = { ULTIMATE_ENV: 'development' };
const KEY = 'org/org-1/evidence/receipt.txt';
const roots: string[] = [];

const throwaway = (prefix: string): string => {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
};

/** The boot's own binding: the embedded disk it would install if the app had declared none. */
const embedded = (): DevServices => {
  const root = throwaway('x-storage-redeclare-boot-');
  return {
    storage: { name: 'storage', mode: 'embedded', url: `file://${join(root, 'disk')}`, detail: '' },
    stateDir: root,
  } as unknown as DevServices;
};

afterEach(() => {
  resetStorage();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('live · storage booted twice over a populated app disk', () => {
  test('reads the object and resolves the signed URL written before the second boot', async () => {
    // The app module `runtime.ts` reaches: a NAMED disk, declared before any boot runs.
    defineStorage({
      disks: {
        evidence: localDriver({
          root: join(throwaway('x-storage-redeclare-app-'), 'evidence'),
          signingSecret: 'redeclare-test-secret',
          env: DEV,
        }),
      },
      default: 'evidence',
    });

    startStorage(embedded(), DEV);
    await disk('evidence').put(KEY, new TextEncoder().encode('paid'), {
      contentType: 'text/plain',
    });
    const url = await disk('evidence').signedUrl(KEY, { expiresInMs: 60_000 });

    // A second boot in the same process — a restart path, a test harness, a re-imported runtime.
    startStorage(embedded(), DEV);

    const read = await disk('evidence').get(KEY);
    expect(new TextDecoder().decode(read.bytes)).toBe('paid');
    const signed = await readSignedObject({ url, disk: disk('evidence'), orgId: 'org-1' });
    expect(new TextDecoder().decode(signed.bytes)).toBe('paid');
  });
});
