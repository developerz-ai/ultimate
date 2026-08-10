// Single responsibility: the framework's ONE colour grammar — hex or `transparent`, nothing else.
// It is a parser over strings with no knowledge of pixels, so it lives beside the resampler rather
// than inside it; and it stays deliberately tiny because a second accepted spelling is a second
// thing an agent has to guess right, for a padding colour nobody looks at twice.

import { imageUnsupported } from './errors';

const COLOR_FIX =
  "pass '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' or 'transparent' — hex or transparent, " +
  'there are no named colours';

const HEX = /^#[0-9a-f]+$/;
/** '#rgb', '#rgba', '#rrggbb', '#rrggbbaa' — the whole grammar, hash included. */
const HEX_LENGTHS: readonly number[] = [4, 5, 7, 9];

/** Hex or `transparent`, nothing else — one way to write a colour is one thing to get wrong. */
export function parseColor(value: string): readonly [number, number, number, number] {
  const text = value.toLowerCase();
  if (text === 'transparent') return [0, 0, 0, 0];
  if (!HEX.test(text) || !HEX_LENGTHS.includes(text.length)) {
    throw imageUnsupported(`'${value}' is not a colour this pipeline understands`, COLOR_FIX, {
      value,
    });
  }
  const hex = text.slice(1);
  const short = hex.length < 6;
  const size = short ? 1 : 2;
  const channel = (index: number): number => {
    const part = hex.slice(index * size, index * size + size);
    return Number.parseInt(short ? part + part : part, 16);
  };
  const opaque = hex.length === 3 || hex.length === 6;
  return [channel(0), channel(1), channel(2), opaque ? 255 : channel(3)];
}
