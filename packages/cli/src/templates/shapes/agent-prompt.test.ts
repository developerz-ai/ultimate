// What the agent shape's eval test answers a prompt edit with: a coded X_EVAL_* error whose fix is
// the re-record command and the version bump — never a bare `expect` whose fix re-runs the same
// failure — and a baseline per version, checked before `assert` can re-record over it.

import { describe, expect, test } from 'bun:test';
import { promptFiles, SUGGEST_TITLE_PROMPT } from './agent-prompt';

const DIR = 'apps/web/app/assistant/prompts';

const textAt = (path: string): string => {
  const file = promptFiles().find((candidate) => candidate.path === path);
  return typeof file?.contents === 'string' ? file.contents : '';
};

describe('unit · the agent shape eval refuses an edited template under its old version', () => {
  const evalTest = textAt(`${DIR}/suggest-title.eval.test.ts`);

  test('the refusal is X_EVAL_BASELINE_MISSING: re-record, after bumping the version', () => {
    expect(evalTest).toContain('throw new EvalBaselineMissingError({');
    expect(evalTest).toContain(
      "fix: 'ULTIMATE_EVAL_RECORD=1 x test eval   # after bumping version in apps/web/app/assistant/prompts/suggest-title.ts",
    );
    expect(evalTest).not.toContain('expect((await readBaseline(path))?.promptHash)');
  });

  test('checked before assert, so a re-record that kept the version is refused too', () => {
    // Inside the one test that records, before it can: a failed sibling test would not stop it.
    const recordingTest = evalTest.slice(evalTest.indexOf("test('suggest-title holds"));
    const check = recordingTest.indexOf('await refuseAnEditUnderItsVersion();');
    expect(check).toBeGreaterThan(-1);
    expect(check).toBeLessThan(recordingTest.indexOf('suggestTitleEval.assert('));
    // Absence is the record run's to fill only while recording; the gate refuses it.
    expect(evalTest).toContain('if (recorded === undefined && recordingBaselines()) return;');
  });

  test('one baseline per version: the eval and the written file name the same one', () => {
    const evals = textAt(`${DIR}/suggest-title.evals.ts`);
    expect(evals).toContain(`./suggest-title.v\${suggestTitlePrompt.version}.baseline.json`);
    expect(evals).toContain('  baseline: BASELINE,');
    const written = `${DIR}/suggest-title.v${SUGGEST_TITLE_PROMPT.version}.baseline.json`;
    expect(textAt(written)).toContain(`"promptHash"`);
  });
});
