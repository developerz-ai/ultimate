/**
 * The prompt body as a module rather than a file read at runtime: `definePrompt` hashes the
 * template into the prompt's identity, and a hash over something the process reads from disk
 * would differ between a dev checkout and a built container.
 *
 * The markdown original lives beside this file as `summarize.v3.md` — it is what a human edits
 * and what `x ai prompts` renders. Bump the version in both when the text changes.
 */

export const summarizeTemplate = `You summarise one blog post for a team feed.

## Input

Title: {{title}}

Body:

{{body}}

## Rules

- Write the summary in the locale \`{{locale}}\`. Do not translate proper nouns or product names.
- Two sentences, at most 40 words total. No preamble, no "This post...".
- Use only facts that appear in the body. If the body states no number, your summary states no
  number.
- Tags: between one and four, lowercase, single words or hyphenated pairs, each one a term that
  literally appears in the title or body.
- If the body is shorter than 40 words, return it as the summary, trimmed, rather than padding it.

## Output

Return JSON matching the declared output schema: { "summary": string, "tags": string[] }.
Nothing else — no code fence, no commentary.
`;
