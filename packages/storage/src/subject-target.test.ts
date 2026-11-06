// `storageSubjectTarget` over the memory disk: the export lists the app-named keys that exist, a
// page at a time; the erase deletes them in bounded batches and answers short once they are gone.

import { describe, expect, test } from 'bun:test';
import { memoryStorageDriver } from './driver-memory';
import { storageSubjectTarget } from './subject-target';

const bytes = new TextEncoder().encode('avatar');

describe('storageSubjectTarget', () => {
  test('exports what exists, pages by the key list, and erases in batches', async () => {
    const disk = memoryStorageDriver();
    for (const key of ['avatars/me.png', 'docs/me.pdf', 'avatars/you.png']) {
      await disk.put(key, bytes, { contentType: 'image/png' });
    }
    const target = storageSubjectTarget(
      () => disk,
      async ({ key }) => [`avatars/${key}.png`, `docs/${key}.pdf`, `missing/${key}`],
      { name: 'uploads' },
    );
    const ref = { key: 'me', row: {} };
    expect(target.name).toBe('uploads');
    const first = await target.exportPage(ref, null, 2);
    expect(first.rows.map((row) => row['key'])).toEqual(['avatars/me.png', 'docs/me.pdf']);
    expect(first.rows[0]?.['size']).toBe(bytes.byteLength);
    expect((await target.exportPage(ref, first.cursor, 2)).rows).toEqual([]);

    expect(await target.erase(ref, 1)).toBe(1);
    expect(await target.erase(ref, 1)).toBe(1);
    expect(await target.erase(ref, 1)).toBe(0);
    expect(await disk.exists('avatars/me.png')).toBe(false);
    expect(await disk.exists('avatars/you.png')).toBe(true);
  });
});
