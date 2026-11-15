// The one ordered list of codemods `x upgrade` runs, in run order (`since`, then `id`). A codemod
// module not listed here is refused by `index.test.ts`; `scripts/template-codemods.ts` refuses a
// scaffold-owned template change with no codemod (or no written reason) for the next release.

import { codemod as authenticatorSessionRefusal } from './authenticator-session-refusal';
import { codemod as chartDashboard } from './chart-dashboard';
import type { Codemod } from './codemod';
import { codemod as formatEditedHook } from './format-edited-hook';
import { codemod as reproGitignore } from './repro-gitignore';
import { codemod as runtimePin } from './runtime-pin';
import { codemod as solidFloor } from './solid-floor';
import { codemod as testPorts } from './test-ports';
import { codemod as testSuites } from './test-suites';
import { codemod as vendoredGuards } from './vendored-guards';
import { codemod as verifyFloorSkips } from './verify-floor-skips';

export const CODEMODS: readonly Codemod[] = [
  chartDashboard,
  authenticatorSessionRefusal,
  formatEditedHook,
  testPorts,
  testSuites,
  verifyFloorSkips,
  reproGitignore,
  runtimePin,
  solidFloor,
  vendoredGuards,
];
