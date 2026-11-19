// Direction is the SCRIPT's: a tag that names its script is answered by it, and only a tag that
// names none falls back to the language's usual one.

import { describe, expect, test } from 'bun:test';
import { directionOf, isRtl } from './locale-direction';

describe('directionOf', () => {
  test('a language written right-to-left by default is rtl, with or without a region', () => {
    for (const tag of ['ar', 'ar-EG', 'he-IL', 'fa', 'ur-PK', 'ckb', 'AR-eg']) {
      expect(directionOf(tag)).toBe('rtl');
    }
    for (const tag of ['en', 'de-DE', 'ja', 'zh-Hant-TW']) expect(directionOf(tag)).toBe('ltr');
  });

  test('an explicit script subtag decides direction', () => {
    // Was read off the language alone: Azerbaijani in Arabic script rendered ltr, and Kashmiri in
    // Devanagari or Sindhi in Latin rendered rtl.
    for (const tag of ['az-Arab', 'az-Arab-IR', 'pa-Arab-PK', 'uz-arab', 'ku-Arab-IQ', 'yi-Hebr']) {
      expect(isRtl(tag)).toBe(true);
    }
    for (const tag of ['ks-Deva', 'sd-Deva-IN', 'ar-Latn', 'ug-Cyrl', 'fa-latn', 'az-Latn-AZ']) {
      expect(isRtl(tag)).toBe(false);
    }
  });

  test('ku with no script is Kurmanji in Latin, ltr; Sorani (ckb) stays rtl', () => {
    expect(directionOf('ku')).toBe('ltr');
    expect(directionOf('ku-TR')).toBe('ltr');
    expect(directionOf('ckb-IQ')).toBe('rtl');
  });

  test('a four-letter REGION-position word is only a script in second place', () => {
    // `ar-EG-x-arab`-style private use or a variant never overrides the language.
    expect(directionOf('en-US-x-arab')).toBe('ltr');
    expect(directionOf('')).toBe('ltr');
  });
});
