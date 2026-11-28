// A published package's manifest facts, as the workspace-check tests build them: one that satisfies
// every rule, so a finding against it is a real one.

import type { ManifestFacts } from './workspace-checks';
import { FIXTURE_EXCLUSION, TEST_EXCLUSION } from './workspace-checks';

export const pkg = (over: Partial<ManifestFacts> & { dir: string }): ManifestFacts => ({
  name: `@ultimat3/${over.dir}`,
  version: '1.0.0',
  private: false,
  frameworkDeps: [],
  files: ['src', TEST_EXCLUSION, FIXTURE_EXCLUSION, 'README.md', 'LICENSE'],
  ...over,
});
