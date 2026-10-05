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

/**
 * The 1-based line each direct write STARTS on, matched over the whole source rather than line by
 * line: `\s*` spans newlines, so a chain split as `process.stdout\n  .write(…)` is one match that no
 * single line contains. The mask keeps newlines, so a match offset still names its line.
 */
function writeLines(source: string): readonly number[] {
  const every = new RegExp(DIRECT_WRITE.source, 'g');
  return [...source.matchAll(every)].map(
    (match) => source.slice(0, match.index).split('\n').length,
  );
}

/** Every `<file>:<line>` in this package that writes to fd 1 or 2 past `write-line.ts`. */
async function directWrites(): Promise<readonly string[]> {
  const hits: string[] = [];
  for (const path of shippedSources()) {
    // Comments blanked first: `write-line.ts` explains WHY in prose that names the call.
    const source = stripComments(await Bun.file(join(SRC, path)).text());
    for (const line of writeLines(source)) hits.push(`${path}:${line}`);
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

  test('a call split across lines is still a hit, on the line it starts', () => {
    // Biome wraps a long chain as `process.stdout\n  .write(line)`: no single line holds the call.
    const source = "const a = 1;\nprocess.stdout\n  .write(line);\nprocess.stderr.write('x');\n";
    expect(writeLines(source)).toEqual([2, 4]);
    expect(writeLines(stripComments('// process.stdout\n// .write(x)\n'))).toEqual([]);
  });

  test('the scan sees the call it exists for, and not the prose about it', () => {
    expect(DIRECT_WRITE.test('process.stdout.write(`x\\n`);')).toBe(true);
    expect(DIRECT_WRITE.test('  process.stderr .write(line)')).toBe(true);
    expect(DIRECT_WRITE.test(stripComments('// never process.stdout.write here'))).toBe(false);
    expect(DIRECT_WRITE.test('writeLine(line)')).toBe(false);
  });
});
