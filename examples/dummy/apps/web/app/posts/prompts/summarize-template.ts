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
- Two sentences, maximum. No preamble, no "This post…".
- Up to four tags, each one word, each drawn from words that actually appear in the body.
- Return JSON: { "summary": string, "tags": string[] }.
`;
