// Single responsibility: the system prompt ONE agent run sends — the prompt's static text and what
// the declaration's `system()` loaded, composed into the stable and per-run parts a cache keys on.

import type { SystemPrompt } from './prompt-cache';

/**
 * What `system()` adds to the prompt's own `system`. `stable` joins it in the block every run
 * shares — it must be BYTE-identical run to run (sorted, undated), or each run pays a full cache
 * write for it. `run` is a second block after it, for whatever differs.
 */
export interface AgentSystem {
  readonly stable?: string;
  readonly run?: string;
}

/**
 * The system prompt one run sends: the prompt's static text and `system()`'s stable part as ONE
 * block (the half every run shares), the per-run part after it. A plain string when there is no
 * per-run part — the shape every request had before the parts existed.
 */
export function systemOf(
  fixed: string | undefined,
  extra: AgentSystem,
  redact: (text: string) => string,
): SystemPrompt | undefined {
  const stable = [fixed ?? '', extra.stable ?? '']
    .filter((part) => part !== '')
    .map(redact)
    .join('\n\n');
  const run = extra.run === undefined || extra.run === '' ? '' : redact(extra.run);
  if (run !== '') return { stable, run };
  return fixed === undefined && stable === '' ? undefined : stable;
}

/** Whether two composed prompts are the same text — what `llm.redacted` compares. */
export const sameSystem = (a: SystemPrompt | undefined, b: SystemPrompt | undefined): boolean =>
  JSON.stringify(a) === JSON.stringify(b);
