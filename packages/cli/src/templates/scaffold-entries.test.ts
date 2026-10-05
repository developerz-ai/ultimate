// The server entry's one platform decision — "am I a compiled binary?" — is core's
// `isCompiledBundle`, never a literal prefix. A Windows binary reports `B:\~BUN\root`, so the
// literal `/$bunfs` test resolved the app root inside the bundle and every registry booted empty.

import { describe, expect, test } from 'bun:test';
import { entryFiles } from './scaffold-entries';

const server = (): string => {
  const file = entryFiles().find((entry) => entry.path === 'apps/web/server.ts');
  if (file === undefined) return expect.unreachable('entryFiles() wrote no apps/web/server.ts');
  return typeof file.contents === 'string'
    ? file.contents
    : new TextDecoder().decode(file.contents);
};

describe('the scaffolded server entry', () => {
  test('asks core whether it runs from a compiled bundle, on every platform', () => {
    const source = server();
    expect(source).toContain("import { isCompiledBundle } from '@ultimat3/core';");
    expect(source).toContain('const root = isCompiledBundle(import.meta.dir)');
  });

  test('carries no hand-written bundle prefix a Windows binary would miss', () => {
    expect(server()).not.toMatch(/startsWith\(\s*['"`]\/\$bunfs/);
  });
});
