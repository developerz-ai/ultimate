// 31.53.0: the agent kit's commands an agent runs without a prompt. `x shot` is what the `web` agent
// is told to run, `x kit` refreshes the kit, `x upgrade --dry-run` is the upgrade skill's first step.
// Each missing entry is appended to `permissions.allow`; a file that is not the JSON object this
// expects is left as it is, reported with the entries to add by hand.

import { isJsonObject } from '@ultimat3/core';
import type { Codemod } from './codemod';

export const SETTINGS_FILE = '.claude/settings.json';
export const KIT_ALLOW: readonly string[] = [
  'Bash(bunx x shot:*)',
  'Bash(bunx x kit:*)',
  'Bash(bunx x upgrade --dry-run:*)',
];

export const codemod: Codemod = {
  id: 'settings-kit-allow',
  since: '31.53.0',
  summary: '.claude/settings.json allows bunx x shot, bunx x kit and bunx x upgrade --dry-run',
  async run(app) {
    const source = await app.read(SETTINGS_FILE);
    if (source === undefined) return { changed: [], skipped: [] };
    const bail = (reason: string) => ({
      changed: [],
      skipped: [
        {
          path: SETTINGS_FILE,
          reason: `${reason}: add ${KIT_ALLOW.join(', ')} to permissions.allow by hand`,
        },
      ],
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch {
      return bail(`${SETTINGS_FILE} is not JSON`);
    }
    const permissions = isJsonObject(parsed) ? parsed['permissions'] : undefined;
    const allow = isJsonObject(permissions) ? permissions['allow'] : undefined;
    if (!isJsonObject(parsed) || !isJsonObject(permissions) || !Array.isArray(allow)) {
      return bail(`${SETTINGS_FILE} has no permissions.allow list`);
    }
    const missing = KIT_ALLOW.filter((entry) => !allow.includes(entry));
    if (missing.length === 0) return { changed: [], skipped: [] };
    const next = { ...parsed, permissions: { ...permissions, allow: [...allow, ...missing] } };
    await app.write(SETTINGS_FILE, `${JSON.stringify(next, null, 2)}\n`);
    return { changed: [SETTINGS_FILE], skipped: [] };
  },
};
