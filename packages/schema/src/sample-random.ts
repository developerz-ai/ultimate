// The one PRNG the sample walkers draw from. A leaf: `sample-seeded.ts` and `sample-pattern.ts`
// both read it, and the second is imported by `sample-draw.ts`, which the first imports.

/** mulberry32: 32 bits of state, a uniform float in [0, 1) per call, identical on every platform. */
export function mulberry32(state: number): () => number {
  let s = state >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let x = s;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4_294_967_296;
  };
}
