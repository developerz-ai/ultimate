// Panel: Manifest.
// Kills: "is x.manifest.json current?" — the emitted manifest diffed against the committed
// one, so a forgotten `x manifest` is visible before CI says it.

import type { ManifestFact } from './facts';
import type { DevPanel } from './panel';

export interface ManifestPanelData {
  readonly manifest: ManifestFact;
  readonly drifted: boolean;
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
  /** The command that makes the diff go away. Printed in the panel and in `--json`. */
  readonly fix: string;
}

export const manifestPanel: DevPanel<ManifestPanelData> = {
  key: 'manifest',
  titleKey: 'dev.panel.manifest',
  question: 'is the committed x.manifest.json current?',
  async data(sources): Promise<ManifestPanelData> {
    const manifest = await sources.manifest();
    return {
      manifest,
      drifted: manifest.diff.length > 0,
      added: manifest.diff
        .filter((entry) => entry.committed === undefined)
        .map((entry) => entry.path),
      removed: manifest.diff
        .filter((entry) => entry.emitted === undefined)
        .map((entry) => entry.path),
      changed: manifest.diff
        .filter((entry) => entry.emitted !== undefined && entry.committed !== undefined)
        .map((entry) => entry.path),
      fix: 'x manifest',
    };
  },
};
