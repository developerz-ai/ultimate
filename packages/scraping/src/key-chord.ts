// A key chord, parsed ONCE and refused before any key goes down.
//
// `'Meta+K'` is the spelling every scraper in the audit wrote by hand, and every one of them split
// on `+` and handed the pieces to the browser unchecked — so `'Ctrl+K'` held nothing (the browser
// knows `Control`, not `Ctrl`), pressed `K`, and the test went green with the palette closed. The
// grammar is small enough to state in full: zero or more modifiers, joined by `+`, then one key,
// spelled the way the browser spells it. The parse is the whole check, and it runs on every driver
// — an offline driver has no keyboard, but it can still tell a caller the chord is wrong.

import { keyInvalid } from './error-throws';

/** The four modifiers a browser holds, under the names the browser's own keyboard uses. */
export const KEY_MODIFIERS = ['Meta', 'Control', 'Alt', 'Shift'] as const;

export type KeyModifier = (typeof KEY_MODIFIERS)[number];

export interface KeyChord {
  /** In the order written, which is the order they go down; they come up in reverse. */
  readonly modifiers: readonly KeyModifier[];
  /** The browser's own key name — `K`, `Enter`, `Escape`, `ArrowDown`. Never empty. */
  readonly key: string;
}

const isModifier = (word: string): word is KeyModifier =>
  (KEY_MODIFIERS as readonly string[]).includes(word);

/**
 * `'Meta+K'` → `{ modifiers: ['Meta'], key: 'K' }`. Refuses, with `X_SCRAPE_KEY_INVALID`, an
 * unknown modifier, an empty key, a trailing `+`, and a modifier written twice — each is a chord
 * the browser would hold and release differently from what the caller meant, and a chord is the
 * caller's own literal, so the refusal is terminal.
 *
 * The literal `+` key has no spelling in this grammar: `'+'` splits to nothing. Type it with
 * `page.type()`, which is what a character is for; a chord is for a key the page listens to.
 */
export function parseKeyChord(chord: string): KeyChord {
  if (chord === '') throw keyInvalid(chord, 'is empty, so there is no key to press');
  const parts = chord.split('+');
  const key = parts.at(-1) ?? '';
  if (key === '') {
    throw keyInvalid(
      chord,
      "ends in '+', so it names modifiers and no key — the last segment is the key to press",
    );
  }
  const modifiers: KeyModifier[] = [];
  for (const word of parts.slice(0, -1)) {
    if (!isModifier(word)) {
      throw keyInvalid(
        chord,
        `names ${JSON.stringify(word)} as a modifier, and the browser holds only ${KEY_MODIFIERS.join(', ')}`,
      );
    }
    if (modifiers.includes(word)) {
      throw keyInvalid(chord, `holds ${word} twice, and a key held twice comes up once`);
    }
    modifiers.push(word);
  }
  return { modifiers, key };
}
