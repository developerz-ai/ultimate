// One line of a Dockerfile or a workflow, read as a Bun pin and judged against the pin `x new`
// writes now: already there, carried there (a shape an older scaffold wrote), or the app's own
// choice — which is never edited, only reported with the line the scaffold would have written.

import { REQUIRED_BUN } from '../app-root';
import { type BunImage, scaffoldDigestPatch } from '../templates/bun-image';
import { SETUP_BUN } from '../templates/github/ci.yml';

export type LineVerdict =
  | { readonly kind: 'keep' }
  | { readonly kind: 'carry'; readonly to: string }
  /** `to` is the scaffold's line, for the diff; the file is not written. */
  | { readonly kind: 'foreign'; readonly to: string; readonly why: string };

const KEEP: LineVerdict = { kind: 'keep' };

const FROM = /^(\s*FROM\s+(?:--\S+\s+)*)(oven\/bun:([^\s@]+)(?:@(sha256:[0-9a-f]{64}))?)/i;
const TAG = /^(\d+\.\d+(?:\.\d+)?)(-[\w.-]+)?$/;
const RECORDED = /(digest is \\?`?oven\/bun:)(\d+\.\d+\.\d+)(-alpine)/;
const SETUP = /^(\s*(?:-\s*)?uses:\s*)oven-sh\/setup-bun@([^\s#]+)(.*)$/;
const COMMIT = /^[0-9a-f]{40}$/;
const BUN_VERSION = /^(\s*(?:-\s*)?bun-version:\s*)(['"]?)([^'"\s#]+)\2(\s*(?:#.*)?)$/;
const EXACT = /^\d+\.\d+\.\d+$/;
const SERIES = /^(\d+\.\d+)(?:\.x)?$/;

/** `version` against `patch`, read at the version's own precision: `1.4` is not below `1.4.4`. */
export function compareAt(version: string, patch: string): number {
  const held = version.split('.').map(Number);
  const wanted = patch.split('.').map(Number);
  for (let at = 0; at < held.length; at += 1) {
    const difference = (held[at] ?? 0) - (wanted[at] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  return 0;
}

const isComment = (line: string): boolean => line.trimStart().startsWith('#');

/** A `FROM oven/bun:` line against the scaffold's image. */
export function dockerfileLine(line: string, image: BunImage): LineVerdict {
  if (isComment(line)) return KEEP;
  const from = FROM.exec(line);
  if (from === null) return KEEP;
  const [whole, head = '', , tag = '', digest] = from;
  const to = `${head}${image.ref}${line.slice(whole.length)}`;
  const foreign = (why: string): LineVerdict => ({ kind: 'foreign', to, why });
  if (tag.includes('$'))
    return foreign(`the tag is a build arg: set it to ${image.ref} where it is defined`);
  const parts = TAG.exec(tag);
  if (parts === null) return foreign(`oven/bun:${tag} names no version`);
  const order = compareAt(parts[1] ?? '', image.patch);
  if (parts[2] !== `-${image.variant}`) {
    return digest === undefined
      ? foreign(`oven/bun:${tag} is a variant x new does not write, by no digest`)
      : KEEP;
  }
  if (digest === image.digest) return KEEP;
  // A digest no scaffold wrote was chosen or moved since — Dependabot's docker ecosystem does.
  if (digest !== undefined && scaffoldDigestPatch(digest) === undefined) {
    return order < 0
      ? foreign(`oven/bun:${tag} is pinned by a digest x new never wrote, below Bun ${image.patch}`)
      : KEEP;
  }
  if (order > 0) {
    const inspect = `docker buildx imagetools inspect oven/bun:${tag}`;
    return {
      kind: 'foreign',
      to: line,
      why: `oven/bun:${tag} is ahead of x new's pin and has no digest: ${inspect}`,
    };
  }
  return { kind: 'carry', to };
}

/** The "digest is `oven/bun:<patch>`" note, moved with the FROM lines it describes. */
export const recordedLine = (line: string, image: BunImage): string =>
  isComment(line)
    ? line.replace(
        RECORDED,
        (_whole, head: string, _patch: string, variant: string) =>
          `${head}${image.patch}${variant}`,
      )
    : line;

/** A workflow's `uses: oven-sh/setup-bun@…` or `bun-version:` line against the scaffold's. */
export function workflowLine(line: string): LineVerdict {
  if (isComment(line)) return KEEP;
  const setup = SETUP.exec(line);
  if (setup !== null) {
    // A commit pin is a pin, whichever one Dependabot last moved it to.
    return COMMIT.test(setup[2] ?? '')
      ? KEEP
      : { kind: 'carry', to: `${setup[1] ?? ''}${SETUP_BUN}` };
  }
  const key = BUN_VERSION.exec(line);
  if (key === null) return KEEP;
  const [, head = '', quote = '', value = '', tail = ''] = key;
  if (value.includes('$')) return KEEP;
  const to = `${head}${quote}${REQUIRED_BUN}${quote}${tail}`;
  if (EXACT.test(value)) return compareAt(value, REQUIRED_BUN) < 0 ? { kind: 'carry', to } : KEEP;
  const series = SERIES.exec(value)?.[1];
  const scaffold = `${head}'${REQUIRED_BUN}'${tail}`;
  if (series !== undefined && compareAt(series, REQUIRED_BUN) >= 0) return KEEP;
  return {
    kind: 'foreign',
    to: scaffold,
    why: `bun-version ${value} is a pin x new does not write`,
  };
}
