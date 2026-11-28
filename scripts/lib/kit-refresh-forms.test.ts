// `releasedForms` against a throwaway git repo: a tag whose `scaffold-claude.ts` imports the kit
// must render, and its README's hash must be RECORDED. Through `withRecorded` a tag that failed to
// load could hide behind the hashes already committed; here nothing is committed, so it cannot.

import { afterEach, describe, expect, test } from 'bun:test';
// why: Bun has no mkdtemp and no recursive remove.
import { mkdtemp, rm } from 'node:fs/promises';
// why: Bun exposes no tmpdir(), so only node:os answers the platform temp root.
import { tmpdir } from 'node:os';
// why: Bun exposes no path-join primitive.
import { join } from 'node:path';
import { KIT_FORM_NAME, kitFormHash } from '../../packages/cli/src/app-kit-forms';
import { releasedForms } from './kit-refresh-forms';
import { git } from './release-due-git';

const README = '.claude/README.md';
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

const IDENTITY = [
  '-c',
  'user.name=t',
  '-c',
  'user.email=t@example.com',
  '-c',
  'commit.gpgsign=false',
];

/** A repo with one commit holding `files`, tagged `v1.0.0`. */
async function repoWith(files: Readonly<Record<string, string>>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'x-kit-forms-'));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) await Bun.write(join(root, path), text);
  await git(['init', '-q'], root);
  await git(['add', '-A'], root);
  await git([...IDENTITY, 'commit', '-qm', 'release'], root);
  // A ref, not `git tag`: a machine that signs tags would demand a message of a fixture.
  await git(['update-ref', 'refs/tags/v1.0.0', 'HEAD'], root);
  return root;
}

const TEMPLATES = 'packages/cli/src/templates';
const SCAFFOLD = `import { KIT_MARKER } from '../kit/registry';
import type { GeneratedFile, NameSet } from './naming';
import { HOOK } from './scaffold-claude-hook';

export function claudeFiles(app: NameSet): readonly GeneratedFile[] {
  return [{ path: '.claude/README.md', contents: \`readme of \${app.kebab}: \${KIT_MARKER} \${HOOK}\` }];
}
`;
const KIT = {
  'packages/cli/src/kit/registry.ts': "export const KIT_MARKER = '.claude/kit.json';\n",
};
const SIBLING = { [`${TEMPLATES}/scaffold-claude-hook.ts`]: "export const HOOK = 'hook';\n" };

describe('unit · kit-refresh-forms, releasedForms', () => {
  test("a tag's README is rendered through the kit it imports and its hash recorded", async () => {
    const root = await repoWith({
      [`${TEMPLATES}/scaffold-claude.ts`]: SCAFFOLD,
      ...SIBLING,
      ...KIT,
    });
    const forms = await releasedForms(root);
    const rendered = `readme of ${KIT_FORM_NAME}: .claude/kit.json hook`;
    expect([...(forms[README] ?? [])]).toEqual([kitFormHash(rendered, KIT_FORM_NAME)]);
  });

  test('a tag whose kit import cannot load is a coded failure, never a silent skip', async () => {
    const root = await repoWith({ [`${TEMPLATES}/scaffold-claude.ts`]: SCAFFOLD, ...SIBLING });
    await expect(releasedForms(root)).rejects.toMatchObject({ code: 'X_KIT_FORMS_ARCHIVE_FAILED' });
  });

  test('a repo with no tag holds no form', async () => {
    const root = await mkdtemp(join(tmpdir(), 'x-kit-forms-'));
    dirs.push(root);
    await git(['init', '-q'], root);
    expect(await releasedForms(root)).toEqual({});
  });
});
