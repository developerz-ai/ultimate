// Eval coverage: every prompt an app registers must have an eval.
//
// An unevaluated prompt is untested code that costs money and answers users, so it fails the gate
// like an untyped module does. The fact comes from the app's own registries — the prompts
// `definePrompt` registered and the prompts `defineEval` names — never from a filename, so
// renaming a file cannot silently un-gate a prompt.

import { EvalMissingError, promptsWithoutEvals } from '@ultimat3/ai';
import { loadApp } from './app-load';
import type { Finding } from './output';
import { findingFrom } from './output';

export async function checkEvalCoverage(root: string): Promise<readonly Finding[]> {
  // Loading is idempotent per process: `x verify` loads the app once and every later step,
  // including the manifest, reads the same registries.
  await loadApp(root);
  return promptsWithoutEvals().map((prompt) => ({
    ...findingFrom(new EvalMissingError({ prompt: prompt.ref, id: prompt.id })),
    at: prompt.ref,
  }));
}
