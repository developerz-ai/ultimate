// Packs a palette into the flat `vec3[]` a shader takes, into an array allocated once per mount:
// a frame loop that allocated per frame would hand the garbage collector 60 arrays a second.

import type { Rgb } from '../palette';

export function packColours(colours: readonly Rgb[], into: Float32Array): Float32Array {
  colours.forEach((colour, index) => {
    into.set(colour, index * 3);
  });
  return into;
}
