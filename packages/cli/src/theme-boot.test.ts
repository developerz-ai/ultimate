import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises'; // why: Bun has no mkdtemp and no recursive remove.
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive; Bun.file and import() take one already joined.
import { join } from 'node:path';
import { isUltimateError, THEME_STORAGE_KEY } from '@ultimat3/core';
import { cspHashSource } from '@ultimat3/http';
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
    await writeConfig("export const config = { name: 'demo', theme: { defaultMode: 'dark' } };\n");
    expect(await loadThemeMode(root)).toBe('dark');
  });

  test("'system' when the app declares nothing, no theme block, or no file at all", async () => {
    expect(await loadThemeMode(root)).toBe('system');
    await writeConfig('export const config = { name: "demo" };\n');
    expect(await loadThemeMode(root)).toBe('system');
  });

  // Refused by core's validator through the one loader, never carried onto the document — and no
  // longer quietly read as 'system' either.
  test('a value the tokens have no block for is refused', async () => {
    await writeConfig("export const config = { name: 'demo', theme: { defaultMode: 'sepia' } };\n");
    const error: unknown = await loadThemeMode(root).then(
      () => undefined,
      (thrown: unknown) => thrown,
    );
    expect(isUltimateError(error) ? error.code : 'not coded').toBe('X_CONFIG_INVALID');
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
 * The boot stamping one key and `ThemeToggle` writing another was exactly the bug — a visitor's
 * choice never survived a reload. Since 25.0.0 the key is ONE declaration in `@ultimat3/core`
 * that render and ui both import; what this pins is that neither grew its literal back. Read from
 * source text rather than imported: `@ultimat3/cli` does not depend on `@ultimat3/ui`.
 */
describe('unit · render and ui agree on the storage key', () => {
  test('the boot reads the THEME_STORAGE_KEY core declares, and ui declares no key of its own', async () => {
    const theme = Bun.fileURLToPath(new URL('../../ui/src/theme/theme.ts', import.meta.url));
    const source = await Bun.file(theme).text();
    expect(source).toContain("import { THEME_STORAGE_KEY } from '@ultimat3/core';");
    expect(source).not.toContain(JSON.stringify(THEME_STORAGE_KEY).replaceAll('"', "'"));
    expect(themeBoot('system').head).toContain(JSON.stringify(THEME_STORAGE_KEY));
  });

  test('the default attribute the boot stamps is the one ui reads', async () => {
    const theme = Bun.fileURLToPath(new URL('../../ui/src/theme/theme.ts', import.meta.url));
    const source = await Bun.file(theme).text();
    const declared = /export const THEME_DEFAULT_ATTRIBUTE = `\$\{THEME_ATTRIBUTE\}-default`/;
    expect(declared.test(source)).toBe(true);
    expect(themeBoot('dark').head).toContain('"data-theme-default","dark"');
  });
});
