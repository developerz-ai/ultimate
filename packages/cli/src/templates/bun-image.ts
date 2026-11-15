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

/**
 * Every digest a released scaffold's Dockerfile built on, by the exact Bun it was read from. The
 * `FROM` tag names only the series, so this is how the framework reads back the patch of an image
 * it wrote itself; any other digest was chosen or moved by the app. A bump moves the current row
 * here as an earlier one.
 */
const DIGEST_PATCHES: Readonly<Record<string, string>> = {
  // 27.10.3
  'sha256:d888c0ae6c86d7866ff10c5aafdd9077b36aee6455b33dd270fb93c0dd5cef6f': '1.4.2',
  // 28.0.0
  'sha256:629e17411f1f129dbec3af78d5af9c9f2a937435c80349437206c6b0b7422373': '1.4.3',
  // 29.0.0 onward
  [digest]: REQUIRED_BUN,
};

/** The Bun patch a scaffold-written digest holds, or undefined for one no scaffold wrote. */
export const scaffoldDigestPatch = (sha: string): string | undefined =>
  Object.hasOwn(DIGEST_PATCHES, sha) ? DIGEST_PATCHES[sha] : undefined;
