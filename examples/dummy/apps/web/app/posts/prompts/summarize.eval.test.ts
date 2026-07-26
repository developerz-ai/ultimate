/**
 * eval — scored, not pass/fail on a vibe. Runs against recorded fixtures with the judge model
 * and the prompt version pinned, and gates on a drop from the recorded baseline rather than on an
 * absolute score. `x verify` fails if a prompt edit makes this worse; a prompt with no evals file
 * fails `x verify` too.
 */

import { expect, test } from '@ultimat3/testing';
import { summarize, summarizePrompt } from './summarize';

test('summarize stays within its rules across the recorded fixture set', async ({ evaluate }) => {
  const run = await evaluate(summarize, {
    prompt: summarizePrompt,
    baseline: './summarize.v3.baseline.json',
    tolerance: 0.05,
    cases: [
      {
        name: 'english/tenancy',
        slots: {
          locale: 'en',
          title: 'Tenancy is a column, not a convention',
          body: 'Every table carries an org id and every index leads with it, so a forgotten filter is a failed query rather than a leak.',
        },
        assert: [
          { kind: 'schema' },
          { kind: 'rubric', criterion: 'Two sentences or fewer, at most 40 words, no preamble.' },
          { kind: 'contains-no-invented-number' },
        ],
      },
      {
        name: 'spanish/timezones',
        slots: {
          locale: 'es',
          title: 'Nadie formatea una fecha sin zona',
          body: 'La zona horaria vive en la membresía, así que cada fecha se muestra en la zona de quien la lee y el resumen llega a las 09:00 locales.',
        },
        assert: [
          { kind: 'schema' },
          { kind: 'rubric', criterion: 'Written in Spanish; product names left untranslated.' },
        ],
      },
      {
        name: 'short-body/passthrough',
        slots: { locale: 'en', title: 'Money is an integer', body: 'Minor units and a currency.' },
        assert: [
          { kind: 'schema' },
          { kind: 'rubric', criterion: 'Returns the body nearly verbatim instead of padding it.' },
        ],
      },
    ],
  });

  // The gate is the regression, not the absolute number — models drift, prompts should not.
  expect(run.score).toBeGreaterThanOrEqual(run.baseline - 0.05);
  expect(run.failures).toEqual([]);

  // v2 hallucinated tags; this is the case that caught it and the reason the version bumped.
  for (const result of run.cases) {
    for (const tagValue of result.output.tags) {
      expect(`${result.slots.title} ${result.slots.body}`.toLowerCase()).toContain(
        tagValue.replace('-', ' ').split(' ')[0] ?? '',
      );
    }
  }
});
