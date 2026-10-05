// The root `.gitattributes` both the framework and every `x new` app carry: LF in every checkout,
// binaries never rewritten — and the framework's own copy held to the same block, byte for byte.

import { describe, expect, test } from 'bun:test';
// why: Bun ships no path-join primitive; the framework's own .gitattributes is read by repo path.
import { join } from 'node:path';
import {
  BINARY_EXTENSIONS,
  LINE_ENDING_ATTRIBUTES,
  ROOT_GITATTRIBUTES_PATH,
  rootGitattributesFile,
} from './scaffold-gitattributes';

const REPO_ROOT = join(import.meta.dir, '..', '..', '..', '..');

/** The attribute lines, comments and blanks dropped — what git actually reads. */
const rules = (text: string): readonly string[] =>
  text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '' && !line.startsWith('#'));

describe('unit · the root .gitattributes x new writes', () => {
  test('it is written at the app root', () => {
    const file = rootGitattributesFile();
    expect(file.path).toBe(ROOT_GITATTRIBUTES_PATH);
    expect(ROOT_GITATTRIBUTES_PATH).toBe('.gitattributes');
    expect(file.contents.startsWith(LINE_ENDING_ATTRIBUTES)).toBe(true);
  });

  test('the first rule normalises every text file to LF, in the index and in the checkout', () => {
    // First, because git resolves attributes last-match-wins: a later `binary` line must be able
    // to override it, and nothing may precede it that it would silently override.
    expect(rules(rootGitattributesFile().contents)[0]).toBe('* text=auto eol=lf');
  });

  test('every binary extension is a `binary` rule, after the text rule', () => {
    const lines = rules(LINE_ENDING_ATTRIBUTES);
    for (const extension of BINARY_EXTENSIONS) {
      const at = lines.indexOf(`*.${extension} binary`);
      expect(at).toBeGreaterThan(0);
    }
    // The images and fonts an app ships first, and the one the framework repo tracks today.
    for (const extension of ['png', 'ico', 'webp', 'woff2', 'wasm', 'tgz']) {
      expect(BINARY_EXTENSIONS).toContain(extension);
    }
  });

  test('no binary extension is listed twice', () => {
    expect(new Set(BINARY_EXTENSIONS).size).toBe(BINARY_EXTENSIONS.length);
  });
});

describe('unit · the framework repo carries the same block', () => {
  test('the root .gitattributes opens with LINE_ENDING_ATTRIBUTES, verbatim', async () => {
    // One declaration, two projections: a contributor's Windows checkout and an app author's are
    // held by the same lines, so a rule added to one and not the other fails here.
    const text = await Bun.file(join(REPO_ROOT, '.gitattributes')).text();
    expect(text.startsWith(LINE_ENDING_ATTRIBUTES)).toBe(true);
  });

  test('every binary type the repo tracks is covered', async () => {
    const proc = Bun.spawn(['git', 'ls-files'], { cwd: REPO_ROOT, stdout: 'pipe' });
    const tracked = (await new Response(proc.stdout).text()).split('\n');
    await proc.exited;
    const covered = new Set<string>(BINARY_EXTENSIONS);
    const known = new Set(['png', 'webp', 'ico', 'jpg', 'jpeg', 'gif', 'woff', 'woff2', 'wasm']);
    const uncovered = tracked
      .map((path) => path.slice(path.lastIndexOf('/') + 1))
      .filter((name) => name.includes('.'))
      .map((name) => name.slice(name.lastIndexOf('.') + 1).toLowerCase())
      .filter((extension) => known.has(extension) && !covered.has(extension));
    expect(uncovered).toEqual([]);
  });
});
