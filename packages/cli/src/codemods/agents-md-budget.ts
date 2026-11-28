// 31.53.0: lifts an app's default `agentsMdMaxBytes` (12,000 B, or none declared) to the scaffold's
// 13,120 B, so `docs-visual-quality`'s rows fit; a budget the author raised is never touched.
//
// The brief `x new` writes grew by the motion, effect and Visual quality rows (plan 101); without
// this hop an app would get a build error for the framework's own prose.

import { AGENTS_MD_MAX_BYTES } from '@ultimat3/manifest';
import { SCAFFOLD_AGENTS_MD_MAX_BYTES } from '../templates/scaffold-docs';
import { VERIFY_FLOOR_FILE } from '../verify-floor';
import type { Codemod } from './codemod';

export const codemod: Codemod = {
  id: 'agents-md-budget',
  since: '31.53.0',
  summary: `x.verify.json agentsMdMaxBytes ${String(SCAFFOLD_AGENTS_MD_MAX_BYTES)}, the budget the new brief rows need (was the ${String(AGENTS_MD_MAX_BYTES)} default)`,
  async run(app) {
    const source = await app.read(VERIFY_FLOOR_FILE);
    // No floor file is no floor: the default stands, and a floor is the app's to opt into.
    if (source === undefined) return { changed: [], skipped: [] };
    let floor: unknown;
    try {
      floor = JSON.parse(source);
    } catch {
      return {
        changed: [],
        skipped: [
          {
            path: VERIFY_FLOOR_FILE,
            reason: `${VERIFY_FLOOR_FILE} does not parse: fix it, then add "agentsMdMaxBytes": ${String(SCAFFOLD_AGENTS_MD_MAX_BYTES)} by hand`,
          },
        ],
      };
    }
    if (typeof floor !== 'object' || floor === null || Array.isArray(floor)) {
      return { changed: [], skipped: [] };
    }
    const held = Reflect.get(floor, 'agentsMdMaxBytes');
    if (held !== undefined && held !== AGENTS_MD_MAX_BYTES) {
      return { changed: [], skipped: [] };
    }
    await app.write(
      VERIFY_FLOOR_FILE,
      `${JSON.stringify({ ...floor, agentsMdMaxBytes: SCAFFOLD_AGENTS_MD_MAX_BYTES }, null, 2)}\n`,
    );
    return { changed: [VERIFY_FLOOR_FILE], skipped: [] };
  },
};
