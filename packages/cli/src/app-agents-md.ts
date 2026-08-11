// The hand-written half of what an agent reads. `@ultimat3/manifest` owns both context files —
// `x.manifest.json` carries the facts derived from code, `AGENTS.md` the conventions code cannot
// express — so the gate runs that package's own check rather than forming a second opinion about
// what a context file has to be. Warnings never fail: they are judgement calls a human makes.

// Bun ships no `Bun.*` path API: `join` builds the host-separator path the check reads.
import { join } from 'node:path';
import { AGENTS_MD_FILENAME, assertAgentsMd } from '@ultimat3/manifest';
import type { Finding } from './output';
import { findingFrom } from './output';

export interface AgentsMdOutcome {
  readonly findings: readonly Finding[];
  /** Non-fatal observations, carried into `--json` so a human can judge them. */
  readonly warnings: readonly string[];
}

/** `assertAgentsMd` throws `X_AGENTS_MD_*`; a gate step reports, so the error becomes a finding. */
export async function checkAgentsMd(root: string): Promise<AgentsMdOutcome> {
  const path = join(root, AGENTS_MD_FILENAME);
  try {
    const { warnings } = await assertAgentsMd({ path });
    return { findings: [], warnings };
  } catch (error) {
    return { findings: [{ ...findingFrom(error), at: AGENTS_MD_FILENAME }], warnings: [] };
  }
}
