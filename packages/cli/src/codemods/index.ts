// The one ordered list of codemods `x upgrade` runs, in run order (`since`, then `id`). A codemod
// module not listed here is refused by `index.test.ts`; `scripts/template-codemods.ts` refuses a
// scaffold-owned template change with no codemod (or no written reason) for the next release.

import { codemod as agentsDevMcp } from './agents-dev-mcp';
import { codemod as authenticatorSessionRefusal } from './authenticator-session-refusal';
import { codemod as biomeNoDefaultExport } from './biome-no-default-export';
import { codemod as bunfigIslandCoverage } from './bunfig-island-coverage';
import { codemod as chartDashboard } from './chart-dashboard';
import { codemod as ciE2eBrowser } from './ci-e2e-browser';
import type { Codemod } from './codemod';
import { codemod as defineErrorLeaf } from './define-error-leaf';
import { codemod as docsCiParts } from './docs-ci-parts';
import { codemod as docsGateProse } from './docs-gate-prose';
import { codemod as docsIslandRows } from './docs-island-rows';
import { codemod as docsShippedGuards } from './docs-shipped-guards';
import { codemod as docsTestServices } from './docs-test-services';
import { codemod as formatEditedHook } from './format-edited-hook';
import { codemod as helmAlertsObjective } from './helm-alerts-objective';
import { codemod as metricsProbeHealthz } from './metrics-probe-healthz';
import { codemod as reproGitignore } from './repro-gitignore';
import { codemod as runtimePin } from './runtime-pin';
import { codemod as solidFloor } from './solid-floor';
import { codemod as testPorts } from './test-ports';
import { codemod as testSuites } from './test-suites';
import { codemod as themeToggleMountOver } from './theme-toggle-mount-over';
import { codemod as vendoredGuards } from './vendored-guards';
import { codemod as verifyFloorSkips } from './verify-floor-skips';
import { codemod as verifyFloorSteps } from './verify-floor-steps';

export const CODEMODS: readonly Codemod[] = [
  defineErrorLeaf,
  biomeNoDefaultExport,
  docsIslandRows,
  themeToggleMountOver,
  docsCiParts,
  chartDashboard,
  helmAlertsObjective,
  authenticatorSessionRefusal,
  agentsDevMcp,
  docsGateProse,
  formatEditedHook,
  metricsProbeHealthz,
  bunfigIslandCoverage,
  ciE2eBrowser,
  docsTestServices,
  testPorts,
  testSuites,
  verifyFloorSkips,
  docsShippedGuards,
  reproGitignore,
  runtimePin,
  solidFloor,
  vendoredGuards,
  verifyFloorSteps,
];
