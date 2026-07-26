// The blocking <head> snippet that kills the flash of wrong theme. Built from the
// same constants as theme.ts so the two can never disagree. Server/build-only:
// the hash is computed with Bun's hasher for the CSP header.

import { runtimeMissingError } from '../errors';
import { THEME_ATTRIBUTE, THEME_MEDIA_QUERY, THEME_STORAGE_KEY } from './theme';

/**
 * Minified on purpose — this runs before first paint and is inlined into every
 * document. Reads the explicit choice, falls back to the OS, and always stamps
 * `data-theme` so screenshots and Playwright runs are deterministic.
 */
export const THEME_INLINE_SCRIPT =
  `try{var d=document.documentElement,` +
  `s=localStorage.getItem('${THEME_STORAGE_KEY}');` +
  `d.setAttribute('${THEME_ATTRIBUTE}',` +
  `s==='light'||s==='dark'?s:` +
  `matchMedia('${THEME_MEDIA_QUERY}').matches?'dark':'light')}catch(e){}`;

/** The exact tag to inline. No attributes, so the CSP hash stays valid. */
export function themeInlineScriptTag(): string {
  return `<script>${THEME_INLINE_SCRIPT}</script>`;
}

let cachedHash: string | null = null;

/** `sha256-<base64>` for `script-src`. Stable for a given script text. */
export function themeInlineScriptHash(): string {
  if (cachedHash !== null) return cachedHash;
  if (typeof Bun === 'undefined') {
    throw runtimeMissingError(
      'Bun.CryptoHasher to hash the theme inline script',
      'call themeInlineScriptHash() during build or SSR, never in browser code',
    );
  }
  const digest = new Bun.CryptoHasher('sha256').update(THEME_INLINE_SCRIPT).digest('base64');
  cachedHash = `sha256-${digest}`;
  return cachedHash;
}

/** Quoted CSP source expression, ready to concatenate into a `script-src`. */
export function themeInlineScriptCspSource(): string {
  return `'${themeInlineScriptHash()}'`;
}
