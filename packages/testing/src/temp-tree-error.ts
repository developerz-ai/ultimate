// Single responsibility: `X_TEST_TEMP_TREE_LEFT`'s message — a temp tree `dispose()` removed and
// found still on disk. The shape that leaves one is a process the tree never awaited, still writing
// under it while the remove walked it (`e407c015a`); the fix is to hand that process to the tree.

import { renderCauseValue, UltimateError } from '@ultimat3/core';

export class TempTreeLeftError extends UltimateError {
  constructor(input: { readonly path: string; readonly left: readonly string[] }) {
    super({
      code: 'X_TEST_TEMP_TREE_LEFT',
      cause: `${renderCauseValue(input.path)} was removed and still holds ${renderCauseValue(input.left)}: a process the tree never awaited wrote under it while the remove walked it`,
      fix: "tree.track(Bun.spawn(['…'], { cwd: tree.path, env: { ...Bun.env, ...tree.gitEnv } }))   # every child that writes under the tree, or tree.git([...]) for git: dispose() awaits them before it removes anything",
    });
  }
}
