// The Bun image `x new` builds on, as a value: what the `runtime-pin` guard names in a fix and what
// the `runtime-pin` codemod moves an older app to. The Dockerfile template states the same image as
// literal text (scripts/bun-pin.test.ts reads that source), and bun-image.test.ts holds the two equal.

import { REQUIRED_BUN } from '../app-root';

export interface BunImage {
  /** The exact Bun the digest was read from — `engines.bun`'s floor, the patch CI runs. */
  readonly patch: string;
  /** What the `FROM` tag names: the series, so the reader sees which line it follows. */
  readonly series: string;
  readonly variant: string;
  readonly digest: string;
  /** `oven/bun:<series>-<variant>@<digest>`, the text after `FROM`. */
  readonly ref: string;
}

const series = REQUIRED_BUN.split('.').slice(0, 2).join('.');
const variant = 'alpine';
// `docker buildx imagetools inspect oven/bun:1.4.4-alpine` — moved together with REQUIRED_BUN.
const digest = 'sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a';

export const SCAFFOLD_BUN_IMAGE: BunImage = {
  patch: REQUIRED_BUN,
  series,
  variant,
  digest,
  ref: `oven/bun:${series}-${variant}@${digest}`,
};
