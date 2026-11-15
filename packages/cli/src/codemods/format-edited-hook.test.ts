// The format-hook codemod over `.claude/` as `x new` wrote it before 31.22.0, and as it wrote it
// from 31.22.0 to 31.27.0 (a hook running `bunx biome`): the template's own edits run backwards give
// those files, and the codemod gives back exactly what `x new` writes today. A file the app rewrote
// keeps its own text and is reported with the diff.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import { claudeFiles } from '../templates/scaffold-claude';
import { HOOK_PATH } from '../templates/scaffold-claude-hook';
import { memoryCodemodApp } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { BIOME_EDITS, codemod, FORMAT_HOOK_EDITS } from './format-edited-hook';

const SETTINGS = '.claude/settings.json';
const README = '.claude/README.md';

const current: Record<string, string> = {};
for (const file of claudeFiles(names('shop'))) {
  if (typeof file.contents === 'string') current[file.path] = file.contents;
}

/** `edits` undone, last first: each one's `to` must be in the text it is undone from. */
const before = (text: string, edits: readonly SnippetEdit[]): string => {
  let out = text;
  for (const edit of [...edits].reverse()) {
    expect(out).toContain(edit.to);
    out = out.replace(edit.to, () => edit.from);
  }
  return out;
};

const old = (): Record<string, string> => ({
  [SETTINGS]: before(current[SETTINGS] ?? '', FORMAT_HOOK_EDITS[SETTINGS]),
  [README]: before(current[README] ?? '', FORMAT_HOOK_EDITS[README]),
});

/** What `x new` wrote from 31.22.0 to 31.27.0: today's files with only the biome edits undone. */
const stock3122 = (): Record<string, string> =>
  Object.fromEntries(
    Object.entries(BIOME_EDITS).map(([path, edits]) => [path, before(current[path] ?? '', edits)]),
  );

describe('unit · codemod format-edited-hook', () => {
  test('carries 31.28.0, the release whose hook stopped running bunx biome', () => {
    expect(codemod.since).toBe('31.28.0');
  });

  test('a 31.22-to-31.27 app: its bunx biome hook, allowlist and docs become what x new writes today', async () => {
    const files = stock3122();
    expect(files[HOOK_PATH]).toContain("'bunx', 'biome'");
    const app = memoryCodemodApp({ ...files });
    const result = await codemod.run(app);
    expect(result.skipped).toEqual([]);
    expect([...result.changed].sort()).toEqual(Object.keys(BIOME_EDITS).sort());
    for (const path of Object.keys(BIOME_EDITS)) expect(app.files[path]).toBe(current[path]);
    expect(JSON.stringify(app.files)).not.toContain('bunx biome check');
  });

  test('a hook already at the new form, and every file with it, is left alone', async () => {
    const files = Object.fromEntries(
      Object.keys(BIOME_EDITS).map((path) => [path, current[path] ?? '']),
    );
    const app = memoryCodemodApp({ ...files });
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
    expect(app.files).toEqual(files);
  });

  test('a hook script the app rewrote is kept, and reported with the change to make by hand', async () => {
    const edited = (stock3122()[HOOK_PATH] ?? '').replace('timeout: 15_000', 'timeout: 30_000');
    const app = memoryCodemodApp({ [HOOK_PATH]: edited });
    const result = await codemod.run(app);
    expect(app.files[HOOK_PATH]).toBe(edited);
    expect(result.skipped.map((skip) => skip.path)).toEqual([HOOK_PATH]);
    expect(result.skipped[0]?.diff).toContain("+const biome = Bun.which('biome'");
  });

  test('the pre-31.22 settings and README become what x new writes today, with the hook script', async () => {
    const app = memoryCodemodApp(old());
    expect(app.files[SETTINGS]).toContain('$CLAUDE_FILE_PATHS');
    const result = await codemod.run(app);
    expect(result).toEqual({ changed: [SETTINGS, HOOK_PATH, README], skipped: [] });
    for (const path of [SETTINGS, README, HOOK_PATH]) expect(app.files[path]).toBe(current[path]);
  });

  test('a second run changes nothing', async () => {
    const app = memoryCodemodApp(old());
    await codemod.run(app);
    expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
  });

  test('a settings.json whose hook the app rewrote is reported, and no script is written', async () => {
    const edited = (old()[SETTINGS] ?? '').replace('2>/dev/null || true', '|| true');
    const app = memoryCodemodApp({ [SETTINGS]: edited });
    const result = await codemod.run(app);
    expect(app.files).toEqual({ [SETTINGS]: edited });
    expect(result.skipped.map((skip) => skip.path)).toEqual([SETTINGS]);
    expect(result.skipped[0]?.diff).toContain(`/${HOOK_PATH}`);
  });

  test('an app that edited its README prose still gets the working hook', async () => {
    const files = old();
    files[README] = '# mine\n';
    const app = memoryCodemodApp(files);
    const result = await codemod.run(app);
    expect(result.changed).toEqual([SETTINGS, HOOK_PATH]);
    expect(app.files[README]).toBe('# mine\n');
  });

  test('an app with no .claude/ is nothing to do', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });
});
