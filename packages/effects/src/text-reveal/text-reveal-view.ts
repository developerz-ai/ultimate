// Splits text into the pieces that animate. `Intl.Segmenter` with the reader's locale, because
// "words" in Thai or Japanese have no spaces and a flag or a ZWJ emoji is one character, not
// several UTF-16 units.

import { EffectsInvalidValueError } from '../errors';

export const TEXT_REVEAL_BACKEND = 'css';
export type RevealBy = 'word' | 'line' | 'char';

export interface RevealPiece {
  readonly text: string;
  /** Whitespace and punctuation-only runs are laid out but never staggered. */
  readonly animate: boolean;
}

export function splitReveal(text: string, by: RevealBy, locale: string): readonly RevealPiece[] {
  if (by === 'line') {
    return text.split('\n').map((line) => ({ text: line, animate: line.trim() !== '' }));
  }
  const segmenter = new Intl.Segmenter(locale, {
    granularity: by === 'word' ? 'word' : 'grapheme',
  });
  return Array.from(segmenter.segment(text), (part) => ({
    text: part.segment,
    animate: by === 'word' ? part.isWordLike === true : part.segment.trim() !== '',
  }));
}

/** Per-piece delay (ms), shrunk so a long text never takes more than `maxTotalMs` to finish. */
export function revealStepMs(count: number, stepMs = 40, maxTotalMs = 900): number {
  if (!Number.isFinite(stepMs) || stepMs < 0) {
    throw new EffectsInvalidValueError({
      cause: `TextReveal stepMs must be a finite number >= 0, got ${String(stepMs)}.`,
      fix: '<TextReveal text="Hello" stepMs={40} />   // stepMs >= 0, or omit stepMs',
    });
  }
  return count <= 1 ? stepMs : Math.min(stepMs, maxTotalMs / (count - 1));
}
