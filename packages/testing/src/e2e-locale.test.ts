// The locale an e2e browser pins: the app's `defaultLocale`, or nothing — never a guess.

import { afterAll, describe, expect, test } from 'bun:test';
// why: a scratch app root; Bun ships no temp-dir or recursive-delete primitive.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os'; // why: Bun exposes no tmpdir().
import { join } from 'node:path'; // why: Bun ships no path join.
import { e2eDefaultLocale } from './e2e-locale';

const scratch = mkdtempSync(join(tmpdir(), 'x-e2e-locale-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('e2eDefaultLocale', () => {
  test("answers the app's own default locale", async () => {
    const root = join(scratch, 'declared');
    await Bun.write(
      join(root, 'app.config.ts'),
      "export const config = { locales: ['es-co', 'en'], defaultLocale: 'es-co' };\n",
    );
    expect(await e2eDefaultLocale(root)).toBe('es-co');
  });

  test('answers nothing — not a guessed en — when there is no config or it will not load', async () => {
    expect(await e2eDefaultLocale(join(scratch, 'absent'))).toBeUndefined();
    const root = join(scratch, 'broken');
    await Bun.write(join(root, 'app.config.ts'), "throw new TypeError('env missing');\n");
    expect(await e2eDefaultLocale(root)).toBeUndefined();
  });
});
