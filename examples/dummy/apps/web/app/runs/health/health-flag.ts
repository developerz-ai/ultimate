// `/runs/health`'s kill switch, declared once: the page's `load` asks it before its two reads.
// `permanent`, like `digest.enabled` — an ops lever kept for good, so it carries no `expiresAt`.

import { defineFlag } from '@ultimat3/flags';

/**
 * Off, `/runs/health` answers 404 and reads nothing: the window read scans every run of the org
 * in the range, so this sheds it without a deploy when the database is the thing on fire.
 */
export const runHealthEnabled = defineFlag({
  kind: 'permanent',
  key: 'runs.health',
  description: 'ops kill switch for the /runs/health page and its window read',
  targeting: { default: true },
});
