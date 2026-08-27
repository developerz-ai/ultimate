// A workspace missing from the root `references` compiles nowhere: `tsc -b` builds referenced
// projects and nothing else, so the gate's `typecheck` step reports green over code it never read.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no temp-directory primitive: `mkdtemp`/`rm` build and remove the throwaway root
// each case reads, `tmpdir` says where, and `join` is the host-separator path into it.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { fixProblem } from './error-contract';
import { checkRootReferences, unreferencedFinding } from './tsconfig-references';

const withRoot = async (
  tsconfig: string | undefined,
  assert: (root: string) => Promise<void>,
): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'x-tsconfig-refs-'));
  try {
    if (tsconfig !== undefined) await Bun.write(join(root, 'tsconfig.json'), tsconfig);
    await assert(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const REFERENCED = '{"files":[],"references":[{"path":"./packages/core"}]}';

describe('unit · every published workspace is in the root build graph', () => {
  test('a workspace no reference names is a finding', async () => {
    await withRoot(REFERENCED, async (root) => {
      const findings = await checkRootReferences(root, ['core', 'cli']);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.code).toBe('X_PACKAGE_UNREFERENCED');
      expect(findings[0]?.cause).toContain('packages/cli');
      expect(findings[0]?.at).toBe('tsconfig.json');
    });
  });

  test('a referenced workspace is silent, with or without the ./ prefix or a trailing slash', async () => {
    await withRoot(
      '{"references":[{"path":"packages/core/"},{"path":"./packages/cli"}]}',
      async (root) => {
        expect(await checkRootReferences(root, ['core', 'cli'])).toEqual([]);
      },
    );
  });

  // Project references are opt-in: a repo that declares none builds another way (a scaffolded app
  // uses `extends` + `include`), and telling its author to add an entry to a list that is not
  // there would be a fix that makes the build worse.
  test('a root that declares no references at all is not judged', async () => {
    await withRoot('{"compilerOptions":{"strict":true}}', async (root) => {
      expect(await checkRootReferences(root, ['core', 'cli'])).toEqual([]);
    });
  });

  test('no root tsconfig, and a root whose tsconfig does not parse, report nothing', async () => {
    await withRoot(undefined, async (root) => {
      expect(await checkRootReferences(root, ['core'])).toEqual([]);
    });
    await withRoot('{ this is not json', async (root) => {
      expect(await checkRootReferences(root, ['core'])).toEqual([]);
    });
  });

  // The false green this closes: `tsc` accepts JSONC and `Bun.file().json()` rejects it, so a root
  // written the way `tsc --init` writes one was read as "this repo does not use project
  // references" — the check went dark and `typecheck` stayed green over the packages it skipped.
  test('a root written as JSONC is read, not silently treated as having no references', async () => {
    const jsonc = [
      '{',
      '  // The build graph. https://www.typescriptlang.org/tsconfig#references',
      '  "files": [], /* nothing is compiled from the root itself */',
      '  "references": [',
      '    { "path": "./packages/core" },',
      '  ],',
      '}',
    ].join('\n');
    await withRoot(jsonc, async (root) => {
      const findings = await checkRootReferences(root, ['core', 'cli']);
      expect(findings).toHaveLength(1);
      expect(findings[0]?.cause).toContain('packages/cli');
    });
  });

  // A `//` inside a string is a URL, never a comment — and a `,` inside one is not trailing.
  test('a comment marker inside a string value survives the strip', async () => {
    const jsonc = '{"references":[{"path":"./packages/core"}],"x":"https://a.dev/b,]"}';
    await withRoot(jsonc, async (root) => {
      expect(await checkRootReferences(root, ['core'])).toEqual([]);
    });
  });

  // Axiom 4: the fix is the edit, naming the file and the exact entry to add.
  test('the fix names the file, the entry and the command that proves it', () => {
    const { fix } = unreferencedFinding('cli');
    expect(fix).toContain('"path": "./packages/cli"');
    expect(fix).toContain('tsconfig.json');
    expect(fixProblem(fix)).toBeUndefined();
  });
});
