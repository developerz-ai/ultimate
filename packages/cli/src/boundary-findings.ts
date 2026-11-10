// The surface findings `x verify` reports, each carrying the CONCRETE edit as its `fix:`. It said
// `x fix boundary <file>`, which printed a second fix and wrote nothing — a fix whose whole content
// was another command to run for the real one (plan 101 slice 11 j). The planner is the same one
// `x fix boundary` prints from, so the gate and the command cannot disagree about the cut.

// why: a synchronous directory probe; Bun.file answers files.
import { existsSync } from 'node:fs';
// why: Bun exposes no path-join primitive; the probe takes a joined path.
import { join } from 'node:path';
import type { SourceFile } from './app-boundaries';
import { appImportGraph, checkImportRules, readAppSources } from './app-boundaries';
import { siblingModuleFindings } from './app-layout';
import { loaderImportFindings } from './app-loader-imports';
import { appTransportFindings } from './app-transport';
import { planBoundaryCuts } from './boundary-cuts';
import { handRolledSocketFindings } from './hand-rolled-socket';
import { islandDisposerFindings } from './island-disposer';
import type { Finding } from './output';
import { packageBoundaryFindings } from './package-boundaries';

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

/**
 * Read the app's sources once, check them, and hand back findings whose fix is the edit. The
 * browser-transport findings come from the same read and already carry their own edit.
 */
export async function appBoundaryFindings(
  root: string,
  /** The app's sources when the caller has already read them — the gate step reads them once. */
  read?: readonly SourceFile[],
): Promise<readonly Finding[]> {
  const files = read ?? (await readAppSources(root));
  return [
    ...withCutEdits(checkImportRules(files), appImportGraph(files)),
    ...(await appTransportFindings(root, files)),
    ...siblingModuleFindings(files),
    ...islandDisposerFindings(files),
    ...handRolledSocketFindings(files),
    ...(await packageBoundaryFindings(root)),
    // The one rule an app's tests answer to as well (`app-loader-imports.ts`).
    ...loaderImportFindings(await appTests(root)),
  ];
}

/** The app's test files, for the loader rule — none where there is no `apps/` to glob. */
async function appTests(root: string): Promise<readonly SourceFile[]> {
  return existsSync(join(root, 'apps')) ? readAppSources(root, 'tests') : [];
}
