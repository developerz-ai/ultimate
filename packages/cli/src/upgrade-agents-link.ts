// `x upgrade`'s one context-file edit: `x new` writes `AGENTS.md` as a symlink to `CLAUDE.md`, and an
// app scaffolded before that holds two regular files. Byte-identical, the copy becomes the link;
// different, it is reported with the merge to do by hand — which half is right is the author's call.

// why: Bun has no lstat, the one call that tells a link from the file it points at.
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { writeGenerated } from './write-generated';

export const AGENTS_FILE = 'AGENTS.md';
export const CLAUDE_FILE = 'CLAUDE.md';

/**
 * `link` — two identical regular files, so the hop replaces `AGENTS.md` with the link;
 * `linked` — already a symlink; `differs` — two regular files with different text, left alone;
 * `none` — one of the two is missing, so there is no pair to join.
 */
export type AgentsLinkState = 'link' | 'linked' | 'differs' | 'none';

const kindOf = async (path: string): Promise<'file' | 'link' | 'missing'> => {
  try {
    const stat = await lstat(path);
    return stat.isSymbolicLink() ? 'link' : stat.isFile() ? 'file' : 'missing';
  } catch {
    return 'missing';
  }
};

/** Read-only: what the hop would do to `<root>/AGENTS.md`. `--dry-run` reports exactly this. */
export async function planAgentsLink(root: string): Promise<AgentsLinkState> {
  const agents = await kindOf(join(root, AGENTS_FILE));
  if (agents === 'link') return 'linked';
  if (agents === 'missing' || (await kindOf(join(root, CLAUDE_FILE))) !== 'file') return 'none';
  const [held, source] = await Promise.all([
    Bun.file(join(root, AGENTS_FILE)).bytes(),
    Bun.file(join(root, CLAUDE_FILE)).bytes(),
  ]);
  return Buffer.from(held).equals(Buffer.from(source)) ? 'link' : 'differs';
}

/**
 * Performs a `link` plan. The contents are `CLAUDE.md`'s own, so where Windows refuses the link the
 * fallback rewrites the identical copy — the file is unchanged and the next hop asks again.
 */
export async function applyAgentsLink(root: string, state: AgentsLinkState): Promise<void> {
  if (state !== 'link') return;
  const contents = await Bun.file(join(root, CLAUDE_FILE)).bytes();
  await writeGenerated(root, { path: AGENTS_FILE, contents, link: CLAUDE_FILE });
}
