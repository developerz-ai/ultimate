// Every source file in this package is TEXT. A raw NUL byte in a template literal (`toastIdentity`
// held two) runs identically to its `\0` escape, but git then classes the whole file as binary:
// no diff, no blame, no review of any later change to it.

import { describe, expect, test } from 'bun:test';

const ROOT = Bun.fileURLToPath(new URL('..', import.meta.url));

describe('package sources', () => {
  test('carry no raw NUL byte — write the `\\0` escape instead', async () => {
    const files = [
      ...new Bun.Glob('{src,scripts}/**/*.{ts,tsx,scss,json,md}').scanSync({ cwd: ROOT }),
    ];
    expect(files.length).toBeGreaterThan(100);
    const binary: string[] = [];
    for (const file of files) {
      const bytes = new Uint8Array(await Bun.file(`${ROOT}${file}`).arrayBuffer());
      if (bytes.includes(0)) binary.push(file);
    }
    expect(binary).toEqual([]);
  });
});
