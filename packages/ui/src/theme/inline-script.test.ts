import { describe, expect, test } from 'bun:test';
import {
  THEME_INLINE_SCRIPT,
  themeInlineScriptCspSource,
  themeInlineScriptHash,
  themeInlineScriptTag,
} from './inline-script';
import { THEME_ATTRIBUTE, THEME_STORAGE_KEY } from './theme';

describe('theme inline script', () => {
  test('resolves stored choice first, then the OS, and stamps data-theme', () => {
    expect(THEME_INLINE_SCRIPT).toContain(THEME_STORAGE_KEY);
    expect(THEME_INLINE_SCRIPT).toContain(THEME_ATTRIBUTE);
    expect(THEME_INLINE_SCRIPT).toContain('prefers-color-scheme: dark');
    // The stored branch AND its fall-through, as one substring: a pairwise `indexOf` comparison
    // answers -1 for a branch that is no longer in the script, and -1 is less than every real
    // index — so dropping the `light` case read as "stored comes first" while a stored 'light'
    // silently fell through to the OS.
    expect(THEME_INLINE_SCRIPT).toContain("s==='light'||s==='dark'?s:matchMedia(");
  });

  test('stays tiny, single-line, and free of double quotes', () => {
    expect(THEME_INLINE_SCRIPT.length).toBeLessThan(260);
    expect(THEME_INLINE_SCRIPT).not.toContain('\n');
    expect(THEME_INLINE_SCRIPT).not.toContain('"');
  });

  test('the tag carries no attributes so the CSP hash stays valid', () => {
    expect(themeInlineScriptTag()).toBe(`<script>${THEME_INLINE_SCRIPT}</script>`);
  });

  test('hash is a stable sha256 CSP source for the exact script text', () => {
    const expected = new Bun.CryptoHasher('sha256').update(THEME_INLINE_SCRIPT).digest('base64');
    expect(themeInlineScriptHash()).toBe(`sha256-${expected}`);
    expect(themeInlineScriptHash()).toBe(themeInlineScriptHash());
    expect(themeInlineScriptCspSource()).toBe(`'sha256-${expected}'`);
  });
});
