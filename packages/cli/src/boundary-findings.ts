// The surface findings `x verify` reports, each carrying the CONCRETE edit as its `fix:`. It said
// `x fix boundary <file>`, which printed a second fix and wrote nothing — a fix whose whole content
// was another command to run for the real one (plan 101 slice 11 j). The planner is the same one
// `x fix boundary` prints from, so the gate and the command cannot disagree about the cut.

import { appImportGraph, checkImportRules, readAppSources } from './app-boundaries';
import { planBoundaryCuts } from './boundary-cuts';
import type { Finding } from './output';

/** A cut and a finding name one violation when they share its code, its importer and its chain. */
const keyOf = (code: string, at: string | undefined, cause: string): string =>
  [code, at ?? '', cause].join('\u0000');

/** `findings` with every surface violation's `fix` replaced by the cut that clears it. */
export function withCutEdits(
  findings: readonly Finding[],
  graph: Parameters<typeof planBoundaryCuts>[1],
): readonly Finding[] {
  const edits = new Map<string, string>();
  for (const finding of findings) {
    if (finding.at === undefined) continue;
    for (const cut of planBoundaryCuts(finding.at, graph)) {
      edits.set(keyOf(cut.code, cut.at, cut.cause), cut.edit);
    }
  }
  return findings.map((finding) => {
    const edit = edits.get(keyOf(finding.code, finding.at, finding.cause));
    return edit === undefined ? finding : { ...finding, fix: edit };
  });
}

/** Read the app's sources once, check them, and hand back findings whose fix is the edit. */
export async function appBoundaryFindings(root: string): Promise<readonly Finding[]> {
  const files = await readAppSources(root);
  return withCutEdits(checkImportRules(files), appImportGraph(files));
}
