// The 31.20.0 authenticator codemod, run over each shape's file as the template wrote it before:
// the template's own edits run backwards give that file, and the codemod must give back exactly
// what `x new` / `x g sign-in` write today. An app-edited copy is reported, never overwritten.

import { describe, expect, test } from 'bun:test';
import { names } from '../templates';
import { authFiles } from '../templates/scaffold-auth';
import { signedInAuthenticatorFiles } from '../templates/sign-in-authenticator';
import { AUTHENTICATOR_EDITS, codemod } from './authenticator-session-refusal';
import { memoryCodemodApp } from './codemod';
import type { SnippetEdit } from './engine-edits';

const SOURCE = 'apps/web/app/auth/authenticator.ts';
const TEST = 'apps/web/app/auth/authenticator.test.ts';

const today = (files: readonly { path: string; contents?: unknown }[]): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const file of files) {
    if ((file.path === SOURCE || file.path === TEST) && typeof file.contents === 'string') {
      out[file.path] = file.contents;
    }
  }
  return out;
};

/** The file before the change: every edit undone. */
const before = (text: string, edits: readonly SnippetEdit[]): string => {
  let out = text;
  for (const edit of edits) {
    expect(out).toContain(edit.to);
    out = out.replace(edit.to, () => edit.from);
  }
  return out;
};

const SHAPES = [
  ['x new', today(authFiles(names('shop'))), AUTHENTICATOR_EDITS.scaffold],
  ['x g sign-in', today(signedInAuthenticatorFiles()), AUTHENTICATOR_EDITS.signIn],
] as const;

describe('unit · codemod authenticator-session-refusal', () => {
  test('carries 31.20.0', () => {
    expect(codemod.since).toBe('31.20.0');
  });

  for (const [shape, current, edits] of SHAPES) {
    test(`${shape}: the pre-31.20 files become exactly what the template writes today`, async () => {
      const app = memoryCodemodApp({
        [SOURCE]: before(current[SOURCE] ?? '', edits[SOURCE]),
        [TEST]: before(current[TEST] ?? '', edits[TEST]),
      });
      expect(app.files[SOURCE]).not.toContain('isSessionRefusal');
      const result = await codemod.run(app);
      expect(result).toEqual({ changed: [SOURCE, TEST], skipped: [] });
      expect(app.files).toEqual(current);
    });

    test(`${shape}: a second run, or an app already there, changes nothing`, async () => {
      const app = memoryCodemodApp({ ...current });
      expect(await codemod.run(app)).toEqual({ changed: [], skipped: [] });
      expect(app.files).toEqual(current);
    });
  }

  test('an authenticator the app rewrote is reported with the diff and left as it is', async () => {
    const [, current, edits] = SHAPES[0];
    const edited = before(current[SOURCE] ?? '', edits[SOURCE]).replace(
      'return await authenticate(auth, token);',
      'return await authenticate(auth, token.trim());',
    );
    const app = memoryCodemodApp({ [SOURCE]: edited });
    const result = await codemod.run(app);
    expect(app.files[SOURCE]).toBe(edited);
    expect(result.changed).toEqual([]);
    expect(result.skipped.map((skip) => skip.path)).toEqual([SOURCE]);
    expect(result.skipped[0]?.diff).toContain('+      if (isSessionRefusal(error)) return null;');
  });

  test('an app with no authenticator is nothing to do', async () => {
    expect(await codemod.run(memoryCodemodApp({}))).toEqual({ changed: [], skipped: [] });
  });
});
