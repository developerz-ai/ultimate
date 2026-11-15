// The suite floor's rows of the CLI catalog (`messages.ts` composes them): why a step ran no
// check, and the strict-floor notices. Data only — `msg()` is the one lookup.

export const FLOOR_MESSAGES = {
  // One line per step that ran no check (`verify-skip-reason.ts`), under the step table.
  'cli.verify.skip.line': 'skipped: {step} — {reason}',
  'cli.verify.skip.noTypedFiles': 'no *.{type}.test.ts file in this tree',
  'cli.verify.skip.noEval': 'not an app root, and no *.eval.test.ts file',
  'cli.verify.skip.noApp': 'no {file} here, so there is no app to load',
  'cli.verify.skip.noPackages': 'no workspace package under packages/',
  'cli.verify.skip.noManifest': 'no {file} committed, so there is no contract to diff',
  'cli.verify.skip.noRoadmap': 'no {file} here',
  'cli.verify.skip.nothing': 'the step found nothing to check here',
  // Without `strict`, a warning and never red: an existing app meets it on `main` (X_BREAKING_ON_MAIN).
  'cli.verify.unwaived':
    'not strict: {names} ran no check here — give each a suite, or a "skip" why in x.verify.json, then set "strict": true',
  // A `skip` why over a step that ran: the reason is stale, and only a commit can drop it.
  'cli.verify.waiverStale': 'x.verify.json "skip" excuses {step}, which ran here — drop its entry',
} as const;
