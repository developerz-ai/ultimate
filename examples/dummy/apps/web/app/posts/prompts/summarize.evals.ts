/**
 * The eval attached to `posts.summarize`. Every prompt has one — `x verify` fails on a prompt
 * nothing evaluates, because an unevaluated prompt is untested code that costs money and answers
 * users.
 *
 * The cases live here rather than in the test file so the gate can read them without importing a
 * test: `x verify` loads this module, sees the eval named against the prompt, and the eval suite
 * is what actually scores it.
 *
 * Scorers are deterministic on purpose. A judge is a model call, which is a measuring instrument
 * that can drift; a rubric that can be written as code should be.
 */

import type { Scorer } from '@ultimat3/ai';
import { defineEval, jsonSchemaValid } from '@ultimat3/ai';
import { summarizePrompt } from './summarize';

/** `expected` carries the source text, so a scorer can check the answer against it. */
export const summarizeCases = [
  {
    name: 'english/tenancy',
    vars: {
      locale: 'en',
      title: 'Tenancy is a column, not a convention',
      body: 'Every table carries an org id and every index leads with it, so a forgotten filter is a failed query rather than a leak.',
    },
  },
  {
    name: 'spanish/timezones',
    vars: {
      locale: 'es',
      title: 'Nadie formatea una fecha sin zona',
      body: 'La zona horaria vive en la membresía, así que cada fecha se muestra en la zona de quien la lee y el resumen llega a las 09:00 locales.',
    },
  },
  {
    name: 'short-body/passthrough',
    vars: {
      locale: 'en',
      title: 'Money is an integer',
      body: 'Minor units and a currency.',
    },
  },
].map((testCase) => ({ ...testCase, expected: `${testCase.vars.title} ${testCase.vars.body}` }));

const parsed = (output: string): { summary?: unknown; tags?: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];

/**
 * v2 invented tags that appeared nowhere in the post. This is the case that caught it, and the
 * reason the prompt version bumped — as a scorer, so it is scored on every run instead of being
 * re-checked by hand in one assertion.
 */
export const tagsFromSource: Scorer = {
  name: 'tags-from-source',
  score({ output, expected }) {
    const tags = stringsOf(parsed(output)?.tags);
    if (tags.length === 0) return 0;
    const source = (expected ?? '').toLowerCase();
    const grounded = tags.filter((tag) => source.includes(tag.replace('-', ' ').toLowerCase()));
    return grounded.length / tags.length;
  },
};

/** The prompt's own rule: two sentences, forty words. Graded, so half a miss is half a point. */
export const withinTwoSentences: Scorer = {
  name: 'within-two-sentences',
  score({ output }) {
    const summary = parsed(output)?.summary;
    if (typeof summary !== 'string') return 0;
    const sentences = summary.split(/[.!?¿?]+/).filter((part) => part.trim() !== '').length;
    const words = summary.split(/\s+/).filter((word) => word !== '').length;
    return ((sentences <= 2 ? 1 : 0) + (words <= 40 ? 1 : 0)) / 2;
  },
};

export const summarizeEval = defineEval({
  name: 'posts.summarize',
  prompt: summarizePrompt,
  // The gate is the drop from these recorded scores, never an absolute number: models drift,
  // prompts should not. Accepting a new number is a diff in the committed file.
  baseline: import.meta.resolve('./summarize.v3.baseline.json'),
  tolerance: 0.05,
  scorers: [jsonSchemaValid(['summary', 'tags']), tagsFromSource, withinTwoSentences],
  cases: summarizeCases,
});
