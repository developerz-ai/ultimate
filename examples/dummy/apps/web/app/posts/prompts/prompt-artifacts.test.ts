/**
 * unit — every prompt has ONE body. The template module is what runs (and what the prompt's hash
 * is taken over); the versioned `.md` beside it is what a person edits, what `x ai prompts`
 * renders and what `@postly/mcp` hands an agent as "what the model was told". Two copies that may
 * drift are two answers to that question, so the `.md` body — everything after its front matter —
 * must equal the template byte for byte, and the front matter's `version` must be the prompt's.
 *
 * Read from disk HERE, in a test, never at runtime: the template stays a module so the hash is the
 * same in a checkout and a container (`summarize-template.ts`).
 */

import type { Prompt } from '@ultimat3/ai';
import { expect, test } from '@ultimat3/testing';
import { reviewDraftPrompt } from './review-draft';
import { summarizePrompt } from './summarize';

/** Every prompt the app ships, with the artifact that documents it. */
const ARTIFACTS: readonly { readonly prompt: Prompt; readonly file: string }[] = [
  { prompt: summarizePrompt, file: 'summarize.v4.md' },
  { prompt: reviewDraftPrompt, file: 'review-draft.v1.md' },
];

const FRONT_MATTER = /^---\n([\s\S]*?)\n---\n\n/;

for (const { prompt, file } of ARTIFACTS) {
  test(`${file} is ${prompt.ref}'s template, under its own front matter`, async () => {
    const text = await Bun.file(new URL(`./${file}`, import.meta.url)).text();
    const head = FRONT_MATTER.exec(text);
    if (head === null) return expect.unreachable(`${file} opens with no --- front matter ---`);
    expect(head[1]).toContain(`version: ${prompt.version}\n`);
    expect(text.slice(head[0].length)).toBe(prompt.template);
  });
}
