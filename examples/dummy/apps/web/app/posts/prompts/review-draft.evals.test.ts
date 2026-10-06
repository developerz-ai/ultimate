/**
 * unit — the review eval's own scorers, one rule each, so a scorer that scores everything 1 is
 * caught here rather than by a baseline it would quietly re-record. `review-draft.eval.test.ts`
 * runs them together over the cases; this holds each to the rule it names.
 */

import type { Scorer } from '@ultimat3/ai';
import { expect, test } from '@ultimat3/testing';
import { noPraise, verdictMatches, withinThreeSentences } from './review-draft.evals';

const answer = (verdict: string, notes: string): string => JSON.stringify({ verdict, notes });
const score = (scorer: Scorer, output: string, expected?: string): unknown =>
  scorer.score(expected === undefined ? { output } : { output, expected });

test('no-praise refuses praise in either locale, and passes notes about the draft', () => {
  expect(score(noPraise, answer('ready', 'Muy bien.'))).toBe(0);
  expect(score(noPraise, answer('ready', 'Looks good, ship it.'))).toBe(0);
  expect(score(noPraise, answer('ready', 'The second paragraph names the rule.'))).toBe(1);
  expect(score(noPraise, 'not json')).toBe(0);
});

test('verdict-matches and within-three-sentences each decide their one rule', () => {
  expect(score(verdictMatches, answer('ready', 'x'), 'ready')).toBe(1);
  expect(score(verdictMatches, answer('ready', 'x'), 'revise')).toBe(0);
  expect(score(withinThreeSentences, answer('ready', 'One. Two. Three.'))).toBe(1);
  expect(score(withinThreeSentences, answer('ready', 'One. Two. Three. Four.'))).toBe(0);
  expect(score(withinThreeSentences, answer('ready', ''))).toBe(0);
});
