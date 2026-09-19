import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { cspHashSource } from '@ultimat3/http';
import { THEME_STORAGE_KEY } from '@ultimat3/render';
import { loadThemeMode, themeBoot } from './theme-boot';

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'ultimate-theme-boot-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// A fresh path per test: `import()` caches by resolved specifier for the life of the process.
const writeConfig = (body: string) => Bun.write(join(root, 'app.config.ts'), body);

describe('unit · theme.defaultMode has a reader', () => {
  test("'dark' when the app declares it", async () => {
    await writeConfig("export const config = { theme: { defaultMode: 'dark' } };\n");
    expect(await loadThemeMode(root)).toBe('dark');
  });

  test("'system' when the app declares nothing, no theme block, or no file at all", async () => {
    expect(await loadThemeMode(root)).toBe('system');
    await writeConfig('export const config = { name: "x" };\n');
    expect(await loadThemeMode(root)).toBe('system');
  });

  test('a value the tokens have no block for falls back to system, never onto the document', async () => {
    await writeConfig("export const config = { theme: { defaultMode: 'sepia' } };\n");
    expect(await loadThemeMode(root)).toBe('system');
  });
});

describe('unit · the boot tag and its CSP source come from one body', () => {
  test('the hash admits exactly the script the head carries', () => {
    const boot = themeBoot('dark');
    const body = /<script>([\s\S]*?)<\/script>/.exec(boot.head)?.[1] ?? '';
    expect(body.length).toBeGreaterThan(0);
    expect(boot.cspSource).toBe(cspHashSource(body));
    expect(body).toContain('"dark"');
  });

  test("'system' asks the OS and 'light' does not", () => {
    expect(themeBoot('system').head).toContain('prefers-color-scheme');
    expect(themeBoot('light').head).not.toContain('prefers-color-scheme');
  });
});

/**
 * Render sits below ui in the tier table and cannot import it, so each package carries the key as
 * its own literal. This is the pin that keeps them one key: the boot stamping one and
 * `ThemeToggle` writing another was exactly the bug — a visitor's choice never survived a reload.
 * Read from source text rather than imported: `@ultimat3/cli` does not depend on `@ultimat3/ui`.
 */
describe('unit · render and ui agree on the storage key', () => {
  test('THEME_STORAGE_KEY is one literal in both packages', async () => {
    const theme = new URL('../../ui/src/theme/theme.ts', import.meta.url).pathname;
    const source = await Bun.file(theme).text();
    const declared = /export const THEME_STORAGE_KEY = '([^']+)'/.exec(source)?.[1];
    expect(declared).toBe(THEME_STORAGE_KEY);
    expect(themeBoot('system').head).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });
});
