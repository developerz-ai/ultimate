// The agent-kit half of what `x upgrade` says: the count the installed `x kit` wrote, each file it
// touched, and the finding it left for the author — the report names what was refreshed.

import { msg } from './messages';
import type { HopKit } from './upgrade-kit';

export function kitLines(kit: HopKit | undefined): readonly string[] {
  if (kit === undefined) return [];
  if (!kit.reported) return [msg('cli.upgrade.kit.unreported')];
  const created = kit.written.filter((file) => file.action === 'created').length;
  return [
    msg('cli.upgrade.kit', {
      created,
      updated: kit.written.length - created,
      unchanged: kit.unchanged,
    }),
    ...kit.written.map((file) =>
      msg('cli.upgrade.kit.file', { action: file.action, path: file.path }),
    ),
    ...kit.findings.map((finding) =>
      msg('cli.upgrade.kit.finding', {
        code: finding.code,
        at: finding.at ?? '',
        fix: finding.fix,
      }),
    ),
  ];
}
