// The 31.22.0 format-hook codemod over `.claude/` as `x new` wrote it before: the template's own
// edits run backwards give those files, and the codemod gives back exactly what `x new` writes
// today. A settings.json the app rewrote keeps its hook and is reported with the diff.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import { claudeFiles } from '../templates/scaffold-claude';
import { HOOK_PATH } from '../templates/scaffold-claude-hook';
import { memoryCodemodApp } from './codemod';
import type { SnippetEdit } from './engine-edits';
import { codemod, FORMAT_HOOK_EDITS } from './format-edited-hook';

const SETTINGS = '.claude/settings.json';
const README = '.claude/README.md';

const current: Record<string, string> = {};
for (const file of claudeFiles(names('shop'))) {
  if (typeof file.contents === 'string') current[file.path] = file.contents;
}

const before = (text: string, edits: readonly SnippetEdit[]): string => {
  let out = text;
  for (const edit of edits) {
    expect(out).toContain(edit.to);
    out = out.replace(edit.to, () => edit.from);
  }
  return out;
};

const old = (): Record<string, string> => ({
  [SETTINGS]: before(current[SETTINGS] ?? '', FORMAT_HOOK_EDITS[SETTINGS]),
  [README]: before(current[README] ?? '', FORMAT_HOOK_EDITS[README]),
});

describe('unit · codemod format-edited-hook', () => {
  test('carries 31.22.0', () => {
    expect(codemod.since).toBe('31.22.0');
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
