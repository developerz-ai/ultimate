// One rule over this package's shipped source: output goes through `write-line.ts`'s `writeLine` /
// `writeErrorLine`, never `process.stdout.write` / `process.stderr.write`. The latter is async on a
// pipe and `process.exit()` drops what is queued — `packages/cli/CLAUDE.md` stated the rule and two
// `x dev` lines (the HMR note, the supervised-restart note) and the prerender warning broke it anyway (plan 101 K7). Prose
// is not a rule; this is the build error (the `unit` step).

import { describe, expect, test } from 'bun:test';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { stripComments } from '@ultimat3/core';

const SRC = import.meta.dir;

/**
 * Shipped source only. `templates/` is excluded because a template's strings are the APP's code,
 * emitted into a scaffold — never a write this process makes.
 */
const shippedSources = (): readonly string[] =>
  [...new Bun.Glob('**/*.ts').scanSync({ cwd: SRC, absolute: false })]
    .filter((path) => !path.endsWith('.test.ts') && !path.endsWith('.d.ts'))
    .filter((path) => !path.startsWith('templates/'))
    .sort();

const DIRECT_WRITE = /\bprocess\s*\.\s*(?:stdout|stderr)\s*\.\s*write\b/;

/** Every `<file>:<line>` in this package that writes to fd 1 or 2 past `write-line.ts`. */
async function directWrites(): Promise<readonly string[]> {
  const hits: string[] = [];
  for (const path of shippedSources()) {
    // Comments blanked first: `write-line.ts` explains WHY in prose that names the call.
    const source = stripComments(await Bun.file(join(SRC, path)).text());
    source.split('\n').forEach((line, index) => {
      if (DIRECT_WRITE.test(line)) hits.push(`${path}:${index + 1}`);
    });
  }
  return hits;
}

describe('unit · cli output goes through write-line.ts', () => {
  test('no shipped module calls process.stdout.write or process.stderr.write', async () => {
    const hits = await directWrites();
    // No exceptions: every site was moved (plan 101 K7). The fix for each: `import { writeLine, writeErrorLine } from './write-line'` and call it with
    // the line, no trailing newline.
    expect(hits).toEqual([]);
  });

  test('the scan sees the call it exists for, and not the prose about it', () => {
    expect(DIRECT_WRITE.test('process.stdout.write(`x\\n`);')).toBe(true);
    expect(DIRECT_WRITE.test('  process.stderr .write(line)')).toBe(true);
    expect(DIRECT_WRITE.test(stripComments('// never process.stdout.write here'))).toBe(false);
    expect(DIRECT_WRITE.test('writeLine(line)')).toBe(false);
  });
});
