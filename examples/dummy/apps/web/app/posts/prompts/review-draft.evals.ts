/**
 * The eval attached to `posts.review-draft` — every prompt has one, or `x verify` fails it
 * (`X_EVAL_MISSING`). Cases here, scored by `review-draft.eval.test.ts`, for the reason
 * `summarize.evals.ts` gives: the gate reads this module without importing a test.
 *
 * The AGENT arm, not the prompt arm: this prompt drives `reviewDraft`, which may call `summarize`
 * before it answers through its `respond` tool. A single request offering no tools would measure
 * something the agent never runs. Each case is one whole run — the agent's own `vars()` loading
 * the seeded post, its turns, its tools — under the gateway the test hands over.
 *
 * An eval never runs a real tool. `summarize` is answered by the double below; `publishPost` has
 * none on purpose, so a regression that reaches for it ends the run as `X_EVAL_TOOL_UNDOUBLED`
 * instead of publishing.
 *
 * Deterministic scorers only. A verdict is checked against the one each case was written to earn,
 * the notes against the prompt's own rules (three sentences at most, no praise), and the run
 * against the one tool the prompt allows it.
 */

import type { Scorer } from '@ultimat3/ai';
import { calledTool, defineEval, jsonSchemaValid } from '@ultimat3/ai';
import { userActor } from '@ultimat3/core';
import { seedId } from '@ultimat3/entity';
import { reviewDraft } from '../actions/review-draft';

const ACME = seedId('org:acme');

/** A seeded `dev` post, by label: the agent loads it itself, as it would in production. */
const post = (label: string) => ({ postId: seedId(`post:${label}`), orgId: ACME });

/** `expected` is the verdict the draft was written to earn. */
export const reviewDraftCases = [
  { name: 'english/draft-money', expected: 'ready', input: post('draft-money') },
  { name: 'english/tenancy', expected: 'ready', input: post('tenancy') },
  { name: 'english/timezones', expected: 'ready', input: post('timezones') },
];

/** Bruno, the draft's author — `post:read` decides about a member of the post's org. */
export const reviewer = userActor({
  id: seedId('member:bruno'),
  orgId: ACME,
  roles: ['author'],
});

/** What the feed would show: the double `summarize` answers with, whatever post it is asked for. */
export const SUMMARY = { summary: 'Minor units and a currency.', tags: ['money'] };

const parsed = (output: string): { verdict?: unknown; notes?: unknown } | undefined => {
  try {
    const value: unknown = JSON.parse(output);
    return typeof value === 'object' && value !== null ? value : undefined;
  } catch {
    return undefined;
  }
};

/** The verdict the case was written to earn — the whole point of asking. */
export const verdictMatches: Scorer = {
  name: 'verdict-matches',
  score: ({ output, expected }) => (parsed(output)?.verdict === expected ? 1 : 0),
};

/** The prompt's own rule: at most three sentences of notes. */
export const withinThreeSentences: Scorer = {
  name: 'within-three-sentences',
  score({ output }) {
    const notes = parsed(output)?.notes;
    if (typeof notes !== 'string' || notes.trim() === '') return 0;
    return notes.split(/[.!?]+/).filter((part) => part.trim() !== '').length <= 3 ? 1 : 0;
  },
};

/**
 * The prompt's other rule: no praise. A verdict carried by "Muy bien." says nothing a writer can
 * act on — and three short sentences of it pass the length rule, so length alone cannot catch it.
 * Words, not a judge model, in both locales the cases are written in.
 */
const PRAISE =
  /\b(great|good job|nice|lovely|excellent|well done|ship it|looks good|perfect)\b|muy bien|genial|excelente|buen trabajo|perfecto/i;

export const noPraise: Scorer = {
  name: 'no-praise',
  score({ output }) {
    const notes = parsed(output)?.notes;
    return typeof notes === 'string' && !PRAISE.test(notes) ? 1 : 0;
  },
};

export const reviewDraftEval = defineEval({
  name: 'posts.review-draft',
  agent: reviewDraft,
  actor: reviewer,
  baseline: import.meta.resolve('./review-draft.v2.baseline.json'),
  tolerance: 0.05,
  tools: { summarize: () => SUMMARY },
  scorers: [
    jsonSchemaValid(['verdict', 'notes']),
    verdictMatches,
    withinThreeSentences,
    noPraise,
    calledTool('summarize'),
  ],
  cases: reviewDraftCases,
});
